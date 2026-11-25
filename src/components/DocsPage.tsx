// API reference, with examples pointing at this server.

import { useApp } from "../lib/app";
import { useSettings } from "../lib/settings";
import { CopyButton } from "./common";

interface Param {
  name: string;
  hint: string;
}

export function DocsPage() {
  const { t } = useSettings();
  const { server } = useApp();
  const base = server?.publicUrl ?? location.origin;

  const common: Param[] = [
    { name: "q", hint: t("p_q") },
    { name: "limit", hint: t("p_limit") },
    { name: "lat, lon", hint: t("p_near") },
    { name: "lang", hint: t("p_lang") },
    { name: "layers", hint: t("p_layers") },
    { name: "countries", hint: t("p_countries") },
    { name: "bbox", hint: t("p_bbox") },
    { name: "tags", hint: t("p_tags") },
    { name: "format", hint: t("p_format") },
  ];

  return (
    <div className="page docs">
      <section className="card">
        <h2 className="section-title">{t("docsAuth")}</h2>
        <p>{t("docsAuthText")}</p>
        <Sample code={`curl -H "X-API-Key: geo_…" "${base}/v1/autocomplete?q=lyon"`} />
        <p className="small muted">{t("docsErrors")}</p>
      </section>

      <Endpoint method="GET" path="/v1/autocomplete" title={t("endpoint_autocomplete")} text={t("docsAutocomplete")} params={common} example={`${base}/v1/autocomplete?q=rue%20de%20riv&lat=48.86&lon=2.35&limit=5`} />
      <Endpoint method="GET" path="/v1/search" title={t("endpoint_search")} text={t("docsSearch")} params={common} example={`${base}/v1/search?q=gare&countries=be&layers=house&tags=railway:station`} />
      <Endpoint
        method="GET"
        path="/v1/reverse"
        title={t("endpoint_reverse")}
        text={t("docsReverse")}
        params={[
          { name: "lat, lon", hint: t("p_point") },
          { name: "radius", hint: t("p_radius") },
          { name: "limit", hint: t("p_limit") },
          { name: "lang", hint: t("p_lang") },
          { name: "layers", hint: t("p_layers") },
          { name: "format", hint: t("p_format") },
        ]}
        example={`${base}/v1/reverse?lat=50.8467&lon=4.3525`}
      />

      <section className="card">
        <h2 className="section-title">{t("docsResult")}</h2>
        <pre className="code-sample">{`{
  "results": [{
    "id": "W123456",
    "layer": "street",            // house, street, locality, district, city, county, state, country, other
    "label": "Rue de la Loi, 1000 Bruxelles, Belgique",
    "name": "Rue de la Loi",
    "address": { "housenumber": null, "street": "Rue de la Loi", "postcode": "1000",
                 "district": "Pentagone", "city": "Bruxelles", "county": "…", "state": "…",
                 "country": "Belgique", "countryCode": "BE" },
    "lat": 50.8458, "lon": 4.3685,
    "extent": [4.36, 50.846, 4.38, 50.845],   // west, north, east, south
    "distance": 12,                           // reverse only, metres
    "osm": { "type": "W", "id": 123456, "key": "highway", "value": "residential" },
    "region": "europe-belgium"
  }]
}`}</pre>
      </section>

      <section className="card">
        <h2 className="section-title">{t("docsFormats")}</h2>
        <p>{t("docsFormatsText")}</p>
        <table className="data-table compact params">
          <tbody>
            {(["geopol", "geojson", "photon", "compact"] as const).map((fmt) => (
              <tr key={fmt}>
                <td>
                  <code>format={fmt}</code>
                </td>
                <td>{t(`format_${fmt}_doc`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Sample code={`${base}/v1/autocomplete?q=lyon&format=geojson`} />
        <pre className="code-sample">{`// format=compact
{ "results": [{ "id": "R120965", "layer": "city", "label": "Lyon, Auvergne-Rhône-Alpes, France", "lat": 45.758, "lon": 4.835 }] }`}</pre>
      </section>

      <section className="card">
        <h2 className="section-title">{t("docsCache")}</h2>
        <p>{t("docsCacheText")}</p>
      </section>

      <section className="card">
        <h2 className="section-title">{t("docsPhoton")}</h2>
        <p>{t("docsPhotonText")}</p>
        <Sample code={`${base}/api?q=berlin&limit=5&lang=de`} />
        <Sample code={`${base}/reverse?lat=52.5163&lon=13.3777&radius=1`} />
        <p className="small muted">{t("docsPhotonParams")}</p>
      </section>

      <section className="card">
        <h2 className="section-title">{t("docsStatus")}</h2>
        <p>{t("docsStatusText")}</p>
        <Sample code={`${base}/v1/status`} />
      </section>

      <p className="small muted">{t("docsAttribution")}</p>
    </div>
  );
}

function Endpoint({ method, path, title, text, params, example }: { method: string; path: string; title: string; text: string; params: Param[]; example: string }) {
  const { t } = useSettings();
  return (
    <section className="card">
      <h2 className="section-title">
        <span className="method">{method}</span> <code>{path}</code> <span className="muted">· {title}</span>
      </h2>
      <p>{text}</p>
      <table className="data-table compact params">
        <thead>
          <tr>
            <th>{t("parameter")}</th>
            <th>{t("description")}</th>
          </tr>
        </thead>
        <tbody>
          {params.map((p) => (
            <tr key={p.name}>
              <td>
                <code>{p.name}</code>
              </td>
              <td>{p.hint}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Sample code={example} />
    </section>
  );
}

function Sample({ code }: { code: string }) {
  return (
    <div className="code-sample with-copy">
      <code>{code}</code>
      <CopyButton text={code} />
    </div>
  );
}
