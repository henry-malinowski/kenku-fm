import https from "https";
import fs from "fs";
import path from "path";
import { app } from "electron";

let cachedGoodtubeCode: string | null = null;

export function getGoodtubeCode(): string | null {
  /*
  // In development/debug, prefer the local file contents for iterative debugging
  const isDev = process.env.NODE_ENV !== "production" && !process.mas;
  if (isDev) {
    const candidates = [
      path.join(process.cwd(), "goodtube.js"),
      path.join(app.getAppPath(), "goodtube.js"),
      path.join(__dirname, "..", "..", "goodtube.js"),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          try {
            const text = fs.readFileSync(candidate, "utf8");
            // Return the raw local script to allow custom debug edits
            return text;
          } catch {}
        }
      } catch {}
    }
  }
  */
  return cachedGoodtubeCode;
}

export function setGoodtubeCode(code: string) {
  cachedGoodtubeCode = code;
}

export function fetchGoodtubeCode(): Promise<string> {
  const url =
    "https://raw.githubusercontent.com/goodtube4u/goodtube/refs/heads/main/goodtube.js";
  return new Promise((resolve, reject) => {
    const fetchText = (u: string) => {
      https
        .get(u, (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            fetchText(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error("HTTP " + res.statusCode));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (d) => chunks.push(Buffer.from(d)));
          res.on("end", () => {
            const code = Buffer.concat(chunks).toString("utf8");
            cachedGoodtubeCode = code;
            try { console.log("[GoodTube] Cached code length:", code.length); } catch {}
            resolve(code);
          });
        })
        .on("error", (e) => reject(e));
    };
    fetchText(url);
  });
}


