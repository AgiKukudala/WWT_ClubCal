import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ApiError } from "./api/client";
import { App } from "./App";
import { ToastProvider } from "./components/ui";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Only poll while the tab is visible; refetch on focus/reconnect.
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      staleTime: 10_000,
      retry: (count, err) => (err instanceof ApiError && err.status >= 400 && err.status < 500 ? false : count < 4),
      retryDelay: (n) => Math.min(30_000, 1000 * 2 ** n),
    },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
