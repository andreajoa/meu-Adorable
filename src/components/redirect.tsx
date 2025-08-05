"use client";

import { createApp } from "@/actions/create-app";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function AppPageRedirect() {
  const router = useRouter();

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const message = urlParams.get("message");
    const baseId = urlParams.get("baseId");

    if (message) {
      createApp({
        initialMessage: decodeURIComponent(message),
        baseId: baseId as string,
      }).then((app) => {
        router.push(`/app/${app.id}?respond`);
      });
    } else {
      router.push("/");
    }
  });

  return <></>;
}
