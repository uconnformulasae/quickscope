import type { Express } from "express";
import { createServer, type Server } from "http";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // No server-side routes — API is served by the Python/libxrk backend on :8000
  return httpServer;
}
