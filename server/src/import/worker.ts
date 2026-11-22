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
  /** Header lines (the first batch only). */
  dumpDate?: string;
  countries?: { country_code: string; name: Record<string, string> }[];
  error?: string;
}

parentPort!.on("message", (batch: Batch) => {
  const out: BatchResult = { id: batch.id, features: "", addresses: "", featureCount: 0, addressCount: 0 };
  const features: string[] = [];
  const addresses: string[] = [];
  try {
    for (const text of batch.lines) {
      const record = JSON.parse(text) as { type: string; content: unknown };
      if (record.type === "Place") {
        for (const p of record.content as PhotonPlace[]) {
          const rows = placeRows(p, batch.options);
          if (rows.feature) features.push(rows.feature);
          else if (rows.address) addresses.push(rows.address);
        }
      } else if (record.type === "NominatimDumpFile") {
        out.dumpDate = (record.content as { data_timestamp?: string }).data_timestamp;
      } else if (record.type === "CountryInfo") {
        out.countries = record.content as BatchResult["countries"];
      }
    }
  } catch (e) {
    out.error = (e as Error).message;
  }
  out.features = features.join("");
  out.addresses = addresses.join("");
  out.featureCount = features.length;
  out.addressCount = addresses.length;
  parentPort!.postMessage(out);
});
