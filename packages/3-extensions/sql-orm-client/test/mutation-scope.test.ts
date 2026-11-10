import {
  createTransactionStart,
  transactionSettlement,
  transactionStart,
} from '@internal/sql-runtime/internal/prepared-query';
import { describe, expect, it, vi } from 'vitest';
import { withMutationScope } from '../src/mutation-executor';
import { createMockRuntime } from './helpers';

function setup() {
  const runtime = createMockRuntime();
  const transaction = {
    ...runtime,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    [transactionSettlement]: { committed: false, rolledBack: false, logDroppedError: vi.fn() },
  };
  const connection = {
    ...runtime,
    transaction: vi.fn(async () => transaction),
    release: vi.fn(async () => undefined),
    destroy: vi.fn(async (_reason?: unknown) => undefined),
    [transactionStart]: createTransactionStart(),
  };
  return {
    runtime: { ...runtime, connection: vi.fn(async () => connection) },
    connection,
    transaction,
  };
}

describe('mutation scope transaction intent and fallback disposal', () => {
  it('marks an activity-owned start implicit', async () => {
    const { runtime, connection } = setup();
    await withMutationScope({ ...runtime, transaction: connection.transaction }, async () => 42);
    expect(connection.transaction).toHaveBeenCalledExactlyOnceWith({ kind: 'implicit' });
    expect(runtime.connection).not.toHaveBeenCalled();
  });

  it('marks a fallback start implicit and releases after successful settlement', async () => {
    const { runtime, connection } = setup();
    expect(await withMutationScope(runtime, async () => ({ id: 1 }))).toEqual({ id: 1 });
    expect(connection.transaction).toHaveBeenCalledExactlyOnceWith({ kind: 'implicit' });
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'disposes start failure with refusedBeforeBegin=%s without masking it',
    async (refused) => {
      const { runtime, connection } = setup();
      const failure = new Error('start failed');
      connection[transactionStart].refusedBeforeBegin = refused;
      connection.transaction.mockRejectedValue(failure);
      connection.release.mockRejectedValue(new Error('release failed'));
      connection.destroy.mockRejectedValue(new Error('destroy failed'));
      const run = vi.fn(async () => 42);
      await expect(withMutationScope(runtime, run)).rejects.toBe(failure);
      expect(run).not.toHaveBeenCalled();
      expect(connection.release).toHaveBeenCalledTimes(refused ? 1 : 0);
      expect(connection.destroy).toHaveBeenCalledTimes(refused ? 0 : 1);
      if (!refused) expect(connection.destroy).toHaveBeenCalledWith(failure);
    },
  );

  it('destroys an uncertain rollback instead of returning the connection', async () => {
    const { runtime, connection, transaction } = setup();
    const failure = new Error('rollback failed');
    transaction.rollback.mockRejectedValue(failure);
    connection.destroy.mockRejectedValue(new Error('destroy failed'));
    await expect(
      withMutationScope(runtime, async () => {
        throw new Error('callback failed');
      }),
    ).rejects.toBe(failure);
    expect(connection.release).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('preserves settlement metadata when rollback succeeds but its end hook fails', async () => {
    const { runtime, connection, transaction } = setup();
    const failure = new Error('callback failed');
    const hook = new Error('end hook failed');
    transaction.rollback.mockImplementation(async () => {
      transaction[transactionSettlement].rolledBack = true;
      throw hook;
    });
    connection.release.mockRejectedValue(new Error('release failed'));
    await expect(
      withMutationScope(runtime, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(transaction[transactionSettlement].logDroppedError).toHaveBeenCalledWith(hook);
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connection.destroy).not.toHaveBeenCalled();
  });

  it('runs on an existing transaction without starting another', async () => {
    const { connection, transaction } = setup();
    expect(await withMutationScope(transaction, async (scope) => scope === transaction)).toBe(true);
    expect(connection.transaction).not.toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
  });
});
