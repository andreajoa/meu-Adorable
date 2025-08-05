"use server";

import { redisPublisher } from "@/lib/redis";

export async function chatState(appId: string) {
  const streamState = await redisPublisher.get(
    "app:" + appId + ":stream-state"
  );

  return {
    state: streamState,
  };
}
