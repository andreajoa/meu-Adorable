"use client";

import { useState } from "react";

export default function PreviewControls({
  onModeChange,
}: {
  onModeChange?: (mode: "web" | "files") => void;
}) {
  const [activeView, setActiveView] = useState<"web" | "files">("web");

  const handleModeChange = (mode: "web" | "files") => {
    setActiveView(mode);
    onModeChange?.(mode);
  };

  const handleDeploy = () => {
    console.log("Deploy clicked");
  };

  return (
    <div className="flex justify-between items-center w-full">
      <div className="inline-flex rounded-lg bg-gray-200 dark:bg-gray-800 p-0.5 relative">
        <button
          onClick={() => handleModeChange("web")}
          className={`px-4 py-1.5 text-sm z-10 relative transition-colors ${
            activeView === "web"
              ? "text-gray-800 dark:text-white font-medium"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Web
        </button>
        <button
          onClick={() => handleModeChange("files")}
          className={`px-4 py-1.5 text-sm z-10 relative transition-colors ${
            activeView === "files"
              ? "text-gray-800 dark:text-white font-medium"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          }`}
        >
          Files
        </button>
        <div
          className="absolute top-0.5 bottom-0.5 rounded-md bg-white dark:bg-gray-700 shadow-sm"
          style={{
            left: activeView === "web" ? "0.125rem" : "calc(50% + 0.125rem)",
            right: activeView === "files" ? "0.125rem" : "auto",
            width: "calc(50% - 0.25rem)",
            transition: "left 0.2s ease-in-out, right 0.2s ease-in-out",
          }}
        />
      </div>

      {/* <button */}
      {/*   onClick={handleDeploy} */}
      {/*   className="px-4 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors" */}
      {/* > */}
      {/*   Deploy */}
      {/* </button> */}
    </div>
  );
}
