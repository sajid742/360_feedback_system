import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';

type JobHandler = (notificationId: string) => Promise<void>;

/**
 * Delivery queue. When REDIS_HOST is configured AND reachable it uses BullMQ with
 * exponential-backoff retries; otherwise (Redis unset OR unreachable) it degrades
 * gracefully to inline delivery so notifications are still delivered without Redis.
 * (F4: previously a set-but-unreachable REDIS_HOST left messages stuck 'queued'.)
 */
@Injectable()
export class DeliveryQueue implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryQueue.name);
  private queue?: Queue;
  private worker?: Worker;
  private handler?: JobHandler;

  registerHandler(handler: JobHandler): void {
    this.handler = handler;
  }

  async onModuleInit(): Promise<void> {
    const host = process.env.REDIS_HOST;
    if (!host) {
      this.logger.log('Redis not configured — using inline delivery.');
      return;
    }
    const port = Number(process.env.REDIS_PORT ?? 6379);
    // Probe Redis before committing to BullMQ — a set-but-unreachable host must
    // fall back to inline delivery, not silently strand every notification.
    if (!(await this.redisReachable(host, port))) {
      this.logger.warn(`Redis at ${host}:${port} is unreachable — using inline delivery.`);
      return;
    }
    const connection = { host, port };
    this.queue = new Queue('communication', { connection });
    this.worker = new Worker(
      'communication',
      async (job) => {
        if (this.handler) await this.handler(job.data.notificationId as string);
      },
      { connection },
    );
    this.worker.on('failed', (job, err) => this.logger.warn(`Job ${job?.id} failed: ${err.message}`));
    this.logger.log(`Redis delivery queue active at ${host}:${port}.`);
  }

  /** Quick connectivity probe with a short timeout and no retries. */
  private async redisReachable(host: string, port: number): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedisModule = require('ioredis');
    const IORedis = (IORedisModule.default ?? IORedisModule) as new (opts: Record<string, unknown>) => {
      connect(): Promise<void>; ping(): Promise<string>; disconnect(): void; on(ev: string, cb: (e: unknown) => void): void;
    };
    const client = new IORedis({ host, port, lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 1, retryStrategy: () => null });
    client.on('error', () => { /* swallow probe connection errors — handled by the try/catch */ });
    try {
      await client.connect();
      await client.ping();
      return true;
    } catch {
      return false;
    } finally {
      client.disconnect();
    }
  }

  async enqueue(notificationId: string): Promise<void> {
    if (this.queue) {
      await this.queue.add(
        'send',
        { notificationId },
        { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true },
      );
    } else if (this.handler) {
      await this.handler(notificationId);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
