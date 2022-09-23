import * as Sdk from "@reservoir0x/sdk";
import axios from "axios";
import pLimit from "p-limit";

import { db, pgp } from "../../common/db";
import { addToRelayOrdersQueue } from "../relay-orders";
import { logger } from "../../common/logger";
import { Seaport, SeaportOrder } from "../../utils/seaport";
import _ from "lodash";
import { fromUnixTime, format } from "date-fns";
import { config } from "../../config";
import {
  FetchOffersCollection,
  FetchOffersCollections,
} from "../../models/fetch-offers-collections";

const MAX_FETCH_OFFERS_COLLECTIONS = 50;

export const fetchOrders = async () => {
  logger.info("fetch_orders", `Seaport Fetch orders`);

  const seaport = new Seaport();
  let cursor = null;
  let limit = 50;
  let done = false;

  while (!done) {
    const url = seaport.buildFetchOrdersURL({
      orderBy: "created_date",
      orderDirection: "desc",
      limit,
      cursor,
    });

    try {
      const response = await axios.get(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:89.0) Gecko/20100101 Firefox/89.0",
        },
        timeout: 20000,
      });

      const orders: SeaportOrder[] = response.data.orders;
      const parsedOrders: Sdk.Seaport.Order[] = [];
      cursor = response.data.next;
      const values: any[] = [];

      const handleOrder = async (order: SeaportOrder) => {
        const parsed = await seaport.parseSeaportOrder(order);

        if (parsed) {
          parsedOrders.push(parsed);
        }

        values.push({
          hash: order.order_hash.toLowerCase(),
          target:
            parsed?.getInfo()?.contract.toLowerCase() ||
            order.protocol_data.parameters.offer[0].token.toLowerCase(),
          maker: order.maker.address.toLowerCase(),
          created_at: new Date(order.created_date),
          data: order.protocol_data as any,
          source: "opensea",
        });
      };

      const plimit = pLimit(20);
      await Promise.all(orders.map((order) => plimit(() => handleOrder(order))));

      if (values.length) {
        const columns = new pgp.helpers.ColumnSet(
          ["hash", "target", "maker", "created_at", "data", "source"],
          { table: "orders_v23" }
        );

        const result = await db.manyOrNone(
          pgp.helpers.insert(values, columns) + " ON CONFLICT DO NOTHING RETURNING 1"
        );

        // If result is empty, all transactions already exists
        if (_.isEmpty(result)) {
          const lastOrder = _.last(orders);

          if (lastOrder) {
            logger.info(
              "fetch_orders",
              `Seaport empty result cursor=${cursor}, reached to=${lastOrder.created_date}`
            );
          }

          done = true;
        }
      }

      if (parsedOrders.length) {
        await addToRelayOrdersQueue(
          parsedOrders.map((order) => ({
            kind: "seaport",
            data: order.params,
          })),
          true
        );
      }

      logger.info("fetch_orders", `Seaport - DONE - cursor=${cursor} Got ${orders.length} orders`);
    } catch (error) {
      throw error;
    }
  }
};

export const fetchAllOrders = async (
  fromTimestamp: number | null = null,
  toTimestamp: number | null = null,
  cursor: string | null = null
) => {
  let formatFromTimestamp = null;
  let formatToTimestamp = null;

  if (fromTimestamp) {
    formatFromTimestamp = format(fromUnixTime(fromTimestamp), "yyyy-MM-dd HH:mm:ss");
  }

  if (toTimestamp) {
    formatToTimestamp = format(fromUnixTime(toTimestamp), "yyyy-MM-dd HH:mm:ss");
  }

  logger.info(
    "fetch_all_orders",
    `Seaport Fetch all orders fromTimestamp=${formatFromTimestamp}, toTimestamp=${formatToTimestamp}, cursor=${cursor}`
  );

  const seaport = new Seaport();
  let limit = 50;

  const url = seaport.buildFetchOrdersURL({
    orderBy: "created_date",
    orderDirection: "desc",
    limit,
    cursor,
    listedAfter: fromTimestamp,
    listedBefore: toTimestamp,
  });

  try {
    const response = await axios.get(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:89.0) Gecko/20100101 Firefox/89.0",
      },
      timeout: 20000,
    });

    const orders: SeaportOrder[] = response.data.orders;
    const parsedOrders: Sdk.Seaport.Order[] = [];

    const values: any[] = [];

    const handleOrder = async (order: SeaportOrder) => {
      const parsed = await seaport.parseSeaportOrder(order);

      if (parsed) {
        parsedOrders.push(parsed);
      }

      values.push({
        hash: order.order_hash,
        target: (
          parsed?.getInfo()?.contract || order.protocol_data.parameters.offer[0].token
        ).toLowerCase(),
        maker: order.maker.address.toLowerCase(),
        created_at: new Date(order.created_date),
        data: order.protocol_data as any,
        source: "opensea",
      });
    };

    const plimit = pLimit(20);
    await Promise.all(orders.map((order) => plimit(() => handleOrder(order))));

    if (values.length) {
      const columns = new pgp.helpers.ColumnSet(
        ["hash", "target", "maker", "created_at", "data", "source"],
        { table: "orders_v23" }
      );

      const result = await db.manyOrNone(
        pgp.helpers.insert(values, columns) + " ON CONFLICT DO NOTHING RETURNING 1"
      );

      // If new listing were recorded
      if (result.length) {
        logger.info(
          "fetch_all_orders",
          `Seaport - fromTimestamp=${formatFromTimestamp}, toTimestamp=${formatToTimestamp}, New listings found=${result.length}, cursor=${cursor}`
        );
      }
    }

    if (parsedOrders.length) {
      await addToRelayOrdersQueue(
        parsedOrders.map((order) => ({
          kind: "seaport",
          data: order.params,
        })),
        true
      );
    }

    logger.info(
      "fetch_all_orders",
      `Seaport - fromTimestamp=${formatFromTimestamp}, toTimestamp=${formatToTimestamp}, newCursor=${response.data.next} Got ${orders.length} orders`
    );

    return response.data.next;
  } catch (error) {
    throw error;
  }
};

export const fetchCollectionOffers = async (contract: string, tokenId: string) => {
  const seaport = new Seaport();

  const url =
    config.chainId === 1
      ? `https://api.opensea.io/api/v1/asset/${contract}/${tokenId}/offers`
      : `https://testnets-api.opensea.io/api/v1/asset/${contract}/${tokenId}/offers`;

  try {
    const response = await axios.get(url, {
      headers:
        config.chainId === 1
          ? {
              "X-API-KEY": config.realtimeOpenseaApiKey,
            }
          : {},
      timeout: 20000,
    });

    const orders: SeaportOrder[] = response.data.seaport_offers;
    const parsedOrders: Sdk.Seaport.Order[] = [];
    const values: any[] = [];

    const handleOrder = async (order: SeaportOrder) => {
      const parsed = await seaport.parseSeaportOrder(order);

      if (parsed) {
        parsedOrders.push(parsed);
      }

      values.push({
        hash: order.order_hash.toLowerCase(),
        target:
          parsed?.getInfo()?.contract.toLowerCase() ||
          order.protocol_data.parameters.offer[0].token.toLowerCase(),
        maker: order.maker.address.toLowerCase(),
        created_at: new Date(order.created_date),
        data: order.protocol_data as any,
        source: "opensea",
      });
    };

    const plimit = pLimit(20);
    await Promise.all(orders.map((order) => plimit(() => handleOrder(order))));

    if (values.length) {
      const columns = new pgp.helpers.ColumnSet(
        ["hash", "target", "maker", "created_at", "data", "source"],
        { table: "orders_v23" }
      );

      const result = await db.manyOrNone(
        pgp.helpers.insert(values, columns) + " ON CONFLICT DO NOTHING RETURNING 1"
      );

      // If result is empty, all transactions already exists
      if (_.isEmpty(result)) {
        const lastOrder = _.last(orders);

        if (lastOrder) {
          logger.info(
            "fetch_collection_offers",
            `Seaport empty result. reached to=${lastOrder.created_date}`
          );
        }
      }
    }

    if (parsedOrders.length) {
      await addToRelayOrdersQueue(
        parsedOrders.map((order) => ({
          kind: "seaport",
          data: order.params,
        })),
        true
      );
    }

    logger.info(
      "fetch_collection_offers",
      `Seaport - Success. contract:${contract}, tokenId:${tokenId}, orders:${orders.length}`
    );
  } catch (error) {
    logger.error(
      "fetch_collection_offers",
      `Seaport - Error. contract:${contract}, tokenId:${tokenId}, error:${error}`
    );
    throw error;
  }
};

export const getCollectionsToFetchOffers = async () => {
  try {
    const fetchOffersCollections = new FetchOffersCollections("opensea");
    const fetchOffersCollectionsCount = await fetchOffersCollections.count();

    if (fetchOffersCollectionsCount === 0) {
      await refreshCollectionsToFetchOffers();
    }

    return await fetchOffersCollections.getAll();
  } catch (error) {
    logger.error("get_collections", `Failed. error:${error}`);
    return [];
  }
};

export const refreshCollectionsToFetchOffers = async () => {
  try {
    let collections = [];
    let continuation = null;

    for (let i = 0; i < Math.ceil(MAX_FETCH_OFFERS_COLLECTIONS / 20); i++) {
      const response: any = await axios.get(
        continuation
          ? `${process.env.BASE_INDEXER_LITE_API_URL}/collections/v5?limit=20&sortBy=allTimeVolume&continuation=${continuation}`
          : `${process.env.BASE_INDEXER_LITE_API_URL}/collections/v5?limit=20&sortBy=allTimeVolume`,
        {
          timeout: 20000,
        }
      );

      collections.push(...response.data.collections);
      continuation = response.data.continuation;

      if (response.data.collections.length < 20) {
        break;
      }
    }

    if (collections.length) {
      const fetchOffersCollectionToAdd: FetchOffersCollection[] = [];

      for (const collection of collections) {
        try {
          const response = await axios.get(
            `${process.env.BASE_INDEXER_LITE_API_URL}/tokens/ids/v1?collection=${collection.id}&limit=1`,
            {
              timeout: 20000,
            }
          );

          fetchOffersCollectionToAdd.push({
            collection: collection.id,
            contract: collection.primaryContract,
            tokenId: response.data.tokens[0],
          });
        } catch (error) {
          logger.error(
            "refresh_collections",
            `Failed to refresh collection. collectionId=${collection.id}, error:${error}`
          );
        }
      }

      const fetchOffersCollections = new FetchOffersCollections("opensea");
      await fetchOffersCollections.add(fetchOffersCollectionToAdd, true);
    }
  } catch (error) {
    logger.error("refresh_collections", `Failed. error:${error}`);
  }
};
