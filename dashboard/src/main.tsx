import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  applyAppearanceFonts,
  readAppFont,
  readComposedFont,
} from "@/lib/appearanceFonts";
import { installPreloadErrorReload } from "@/lib/chunkReload";
import { LightboxProvider } from "@/lib/lightbox";
import "./index.css";

installPreloadErrorReload();
// Re-apply persisted faces (HTML bootstrap already set them pre-paint).
applyAppearanceFonts(readAppFont(), readComposedFont());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary label="the dashboard">
      <TooltipProvider>
        <LightboxProvider>
          <App />
          <Toaster />
        </LightboxProvider>
      </TooltipProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
