// A parsing thread: turns batches of dump lines into COPY text (parsing is what makes imports slow;
// several of these run at once, see run.ts).

import { parentPort } from "node:worker_threads";
import { placeRows, type ImportOptions, type PhotonPlace } from "./photon.ts";

export interface Batch {
  id: number;
  lines: string[];
  options: ImportOptions;
}

export interface BatchResult {
  id: number;
  features: string;
  addresses: string;
  featureCount: number;
  addressCount: number;
  /** Records that couldn't be read, skipped (and the first reason). */
  skipped: number;
  skipReason?: string;
  /** Header lines (the first batch only). */
  dumpDate?: string;
  countries?: { country_code: string; name: Record<string, string> }[];
  error?: string;
}

parentPort!.on("message", (batch: Batch) => {
  const out: BatchResult = { id: batch.id, features: "", addresses: "", featureCount: 0, addressCount: 0, skipped: 0 };
  const skip = (e: unknown) => {
    out.skipped++;
    out.skipReason ??= (e as Error).message;
  };
  const features: string[] = [];
  const addresses: string[] = [];
  // Each line, and each place in it, on its own: a malformed one is skipped and counted, not fatal.
  for (const text of batch.lines) {
    let record: { type: string; content: unknown };
    try {
      record = JSON.parse(text);
    } catch (e) {
      skip(e);
      continue;
    }
    if (record.type === "Place") {
      for (const p of (Array.isArray(record.content) ? record.content : []) as PhotonPlace[]) {
        try {
          const rows = placeRows(p, batch.options);
          if (rows.feature) features.push(rows.feature);
          else if (rows.address) addresses.push(rows.address);
        } catch (e) {
          skip(e);
        }
      }
    } else if (record.type === "NominatimDumpFile") {
      out.dumpDate = (record.content as { data_timestamp?: string }).data_timestamp;
    } else if (record.type === "CountryInfo") {
      out.countries = record.content as BatchResult["countries"];
    }
  }
  out.features = features.join("");
  out.addresses = addresses.join("");
  out.featureCount = features.length;
  out.addressCount = addresses.length;
  parentPort!.postMessage(out);
});
