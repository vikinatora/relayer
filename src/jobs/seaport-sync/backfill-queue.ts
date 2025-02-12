import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import { redis } from "../../common/redis";
import { fetchAllOrders } from "./utils";
import { logger } from "../../common/logger";
import { config } from "../../config";

const BACKFILL_QUEUE_NAME = "backfill-seaport-sync";

export const backfillQueue = new Queue(BACKFILL_QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 1,
    backoff: {
      type: "fixed",
      delay: 3,
    },
    removeOnComplete: 100,
    removeOnFail: 1000,
  },
});
new QueueScheduler(BACKFILL_QUEUE_NAME, { connection: redis.duplicate() });

if (config.doBackfillWork) {
  const backfillWorker = new Worker(
    BACKFILL_QUEUE_NAME,
    async (job: Job) => {
      const { fromTimestamp, toTimestamp, cursor } = job.data;

      try {
        // If this is the first run
        job.data.newCursor = await fetchAllOrders(fromTimestamp, toTimestamp, cursor);
      } catch (error) {
        job.data.newCursor = cursor;

        logger.error(
          BACKFILL_QUEUE_NAME,
          `SeaPort Sync failed attempts=${job.attemptsMade}, error=${error}`
        );
      }
    },
    { connection: redis.duplicate(), concurrency: 2 }
  );

  backfillWorker.on("completed", async (job) => {
    // Schedule the next sync
    if (job.data.newCursor) {
      await addToSeaportBackfillQueue(
        job.data.fromTimestamp,
        job.data.toTimestamp,
        job.data.newCursor,
        job.opts.priority
      );
    } else {
      logger.info(
        "fetch_all_orders",
        `Seaport - COMPLETED - fromTimestamp=${job.data.fromTimestamp}, toTimestamp=${job.data.toTimestamp}`
      );
    }

    if (job.attemptsMade > 0) {
      logger.info(BACKFILL_QUEUE_NAME, `Sync recover attempts=${job.attemptsMade}`);
    }
  });

  backfillWorker.on("error", (error) => {
    logger.error(BACKFILL_QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const createTimeFrameForBackfill = async (
  fromTimestamp: number,
  toTimestamp: number,
  delayMs: number = 0
) => {
  // Sync specific time frame
  for (let timestamp = fromTimestamp; timestamp <= toTimestamp; timestamp += 60) {
    // Add to the queue with extra seconds to each side
    await addToSeaportBackfillQueue(timestamp - 1, timestamp + 61, null, 0, delayMs);
  }
};

export const addToSeaportBackfillQueue = async (
  fromTimestamp: number | null = null,
  toTimestamp: number | null = null,
  cursor: string | null = null,
  priority: number = 0,
  delayMs: number = 0
) => {
  await backfillQueue.add(
    BACKFILL_QUEUE_NAME,
    { fromTimestamp, toTimestamp, cursor },
    { delay: delayMs, priority }
  );
};
