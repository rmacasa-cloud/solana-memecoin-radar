import express from "express";
import cors from "cors";
import path from "path";
import { WebSocketServer } from "ws";
import { Connection, clusterApiUrl, LogsCallback, Logs } from "@solana/web3.js";

type TokenStats = {
  address: string;
  symbol: string;
  tradesLast5m: number;
  volumeLast5m: number;
  spikeScore: number;
  lastUpdated: number;
};

const PORT = process.env.PORT || 4000;
const SOLANA_RPC_WS =
  process.env.SOLANA_RPC_WS || clusterApiUrl("mainnet-beta").replace("https", "wss");

const tokenMap: Map<string, TokenStats> = new Map();

function symbolFromAddress(address: string): string {
  return address.slice(0, 4) + "..." + address.slice(-4);
}

function computeSpikeScore(stats: TokenStats) {
  const tScore = Math.min(stats.tradesLast5m / 10, 5);
  const vScore = Math.min(stats.volumeLast5m / 1000, 5);
  stats.spikeScore = tScore + vScore;
}

function pruneOldTokens() {
  const now = Date.now();
  for (const [addr, stats] of tokenMap.entries()) {
    if (now - stats.lastUpdated > 5 * 60 * 1000) {
      tokenMap.delete(addr);
    }
  }
}

function getSnapshot(): TokenStats[] {
  return Array.from(tokenMap.values())
    .sort((a, b) => b.spikeScore - a.spikeScore)
    .slice(0, 50);
}

async function main() {
  const app = express();
  app.use(cors());

  const publicDir = path.join(__dirname, "..", "public");
  app.use(express.static(publicDir));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const wss = new WebSocketServer({ server });

  function broadcastSnapshot() {
    const payload = JSON.stringify({ type: "snapshot", data: getSnapshot() });
    wss.clients.forEach((client: any) => {
      if (client.readyState === 1) {
        client.send(payload);
      }
    });
  }

  wss.on("connection", (ws) => {
    console.log("Client connected");
    ws.send(JSON.stringify({ type: "snapshot", data: getSnapshot() }));
  });

  console.log("Connecting to Solana WS:", SOLANA_RPC_WS);
  const connection = new Connection(SOLANA_RPC_WS, "confirmed");

  const handleLogs: LogsCallback = (logs: Logs) => {
    const address = logs.programId.toBase58();
    const now = Date.now();
    const volume = 100 + Math.random() * 900;

    let stats = tokenMap.get(address);
    if (!stats) {
      stats = {
        address,
        symbol: symbolFromAddress(address),
        tradesLast5m: 0,
        volumeLast5m: 0,
        spikeScore: 0,
        lastUpdated: now,
      };
      tokenMap.set(address, stats);
    }

    stats.tradesLast5m += 1;
    stats.volumeLast5m += volume;
    stats.lastUpdated = now;
    computeSpikeScore(stats);
  };

  await connection.onLogs("all", handleLogs);

  setInterval(() => {
    pruneOldTokens();
    broadcastSnapshot();
  }, 3000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
