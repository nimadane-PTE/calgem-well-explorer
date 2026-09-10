declare const Netlify: { env: { get(name: string): string | undefined } };

const WELL_URL = "https://gis.conservation.ca.gov/server/rest/services/WellSTAR/Wells/MapServer/0";
const CITY_URL = "https://gis.conservation.ca.gov/server/rest/services/Base/Base_BOECities/FeatureServer/0";
const MAX_RETURNED_ROWS = 500;

const WELL_FIELDS = [
  "OBJECTID", "Place", "API", "LeaseName", "WellNumber", "WellDesignation",
  "WellStatus", "WellTypeLabel", "OperatorName", "FieldName", "AreaName",
  "District", "CountyName", "SpudDate", "Latitude", "Longitude"
];

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operator", "status", "location_name", "location_type", "action", "fields", "answer_style"],
  properties: {
    operator: { type: ["string", "null"] },
    status: {
      type: ["string", "null"],
      enum: ["Active", "Idle", "Permitted", "Plugged", "Canceled", "Other", null]
    },
    location_name: { type: ["string", "null"] },
    location_type: {
      type: "string",
      enum: ["auto", "city", "field", "county", "district", "area", "place"]
    },
    action: {
      type: "string",
      enum: ["map", "list", "count", "map_and_list"]
    },
    fields: {
      type: "array",
      items: {
        type: "string",
        enum: ["API", "WellNumber", "WellDesignation", "WellStatus", "OperatorName", "FieldName", "AreaName", "District", "CountyName", "Place", "LeaseName", "WellTypeLabel", "SpudDate", "Latitude", "Longitude"]
      },
      maxItems: 8
    },
    answer_style: {
      type: "string",
      enum: ["brief", "table"]
    }
  }
};

function escapeSql(value: string) {
  return String(value).replaceAll("'", "''");
}

function normalize(value: string) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

async function arcgisPost(url: string, params: Record<string, unknown>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  body.set("f", "json");

  const response = await fetch(`${url}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body
  });

  if (!response.ok) throw new Error(`ArcGIS request failed with HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) {
    const details = Array.isArray(json.error.details) ? json.error.details.join(" ") : "";
    throw new Error(`${json.error.message || "ArcGIS error"}${details ? ` — ${details}` : ""}`);
  }
  return json;
}

function statusWhere(status: string | null) {
  if (!status) return "1=1";
  if (status === "Active") return "WellStatus = 'Active'";
  if (status === "Idle") return "WellStatus = 'Idle'";
  if (status === "Permitted") return "WellStatus = 'New'";
  if (status === "Plugged") return "WellStatus IN ('Plugged', 'PluggedOnly')";
  if (status === "Canceled") return "WellStatus = 'Canceled'";
  if (status === "Other") return "(WellStatus IS NULL OR WellStatus NOT IN ('Active','Idle','New','Plugged','PluggedOnly','Canceled'))";
  return "1=1";
}

async function findAttributeMatch(field: string, rawName: string) {
  const wanted = normalize(rawName);
  const exact = await arcgisPost(WELL_URL, {
    where: `UPPER(${field}) = '${escapeSql(wanted)}'`,
    outFields: field,
    returnGeometry: false,
    returnDistinctValues: true,
    resultRecordCount: 100
  });

  const exactValue = exact.features?.map((f: any) => f.attributes?.[field]).find((v: any) => String(v || "").trim());
  if (exactValue) return String(exactValue).trim();

  const contains = await arcgisPost(WELL_URL, {
    where: `UPPER(${field}) LIKE '%${escapeSql(wanted)}%'`,
    outFields: field,
    returnGeometry: false,
    returnDistinctValues: true,
    resultRecordCount: 500
  });

  const values = [...new Set((contains.features || [])
    .map((f: any) => String(f.attributes?.[field] || "").trim())
    .filter(Boolean))] as string[];

  return values.sort((a, b) => a.length - b.length || a.localeCompare(b))[0] || null;
}

async function findCity(rawName: string) {
  const wanted = normalize(rawName.replace(/\s+city$/i, ""));
  const json = await arcgisPost(CITY_URL, {
    where: `UPPER(CITY) = '${escapeSql(wanted)}'`,
    outFields: "CITY,COUNTY",
    returnGeometry: true,
    outSR: 4326,
    resultRecordCount: 100
  });
  if (!json.features?.length) return null;

  const city = String(json.features[0].attributes?.CITY || rawName).trim();
  const counties = [...new Set(json.features.map((f: any) => String(f.attributes?.COUNTY || "").trim()).filter(Boolean))];
  return {
    kind: "city",
    label: counties.length ? `${city} (${counties.join(" / ")} County)` : city,
    geometries: json.features.map((f: any) => f.geometry).filter(Boolean)
  };
}

const LOCATION_FIELDS: Record<string, { field: string; kind: string }> = {
  field: { field: "FieldName", kind: "field" },
  county: { field: "CountyName", kind: "county" },
  district: { field: "District", kind: "district" },
  area: { field: "AreaName", kind: "area" },
  place: { field: "Place", kind: "place" }
};

async function resolveLocation(name: string | null, type: string) {
  if (!name) return null;

  if (type === "city") return findCity(name);
  if (LOCATION_FIELDS[type]) {
    const def = LOCATION_FIELDS[type];
    const match = await findAttributeMatch(def.field, name);
    return match ? { kind: def.kind, label: match, where: `${def.field} = '${escapeSql(match)}'` } : null;
  }

  const city = await findCity(name);
  if (city) return city;

  for (const typeName of ["place", "field", "area", "county", "district"]) {
    const def = LOCATION_FIELDS[typeName];
    const match = await findAttributeMatch(def.field, name);
    if (match) return { kind: def.kind, label: match, where: `${def.field} = '${escapeSql(match)}'` };
  }
  return null;
}

function buildWhere(plan: any, location: any) {
  const clauses = [statusWhere(plan.status)];
  if (plan.operator) clauses.push(`UPPER(OperatorName) LIKE '%${escapeSql(normalize(plan.operator))}%'`);
  if (location?.where) clauses.push(location.where);
  return clauses.join(" AND ");
}

async function matchingIds(where: string, location: any) {
  const ids = new Set<number>();

  if (location?.kind === "city") {
    for (const geometry of location.geometries || []) {
      const json = await arcgisPost(WELL_URL, {
        where,
        geometry: JSON.stringify(geometry),
        geometryType: "esriGeometryPolygon",
        inSR: 4326,
        spatialRel: "esriSpatialRelIntersects",
        returnIdsOnly: true
      });
      for (const id of json.objectIds || []) ids.add(id);
    }
    return [...ids];
  }

  const json = await arcgisPost(WELL_URL, { where, returnIdsOnly: true });
  return Array.isArray(json.objectIds) ? json.objectIds : [];
}

async function fetchRows(objectIds: number[], fields: string[]) {
  const selected = [...new Set(["OBJECTID", ...fields])];
  const rows: any[] = [];
  const limited = objectIds.slice(0, MAX_RETURNED_ROWS);

  for (let i = 0; i < limited.length; i += 1000) {
    const chunk = limited.slice(i, i + 1000);
    const json = await arcgisPost(WELL_URL, {
      objectIds: chunk.join(","),
      outFields: selected.join(","),
      returnGeometry: false
    });
    for (const feature of json.features || []) rows.push(feature.attributes || {});
  }
  return rows;
}

function extractPlannerText(json: any) {
  if (json?.status === "incomplete") {
    const reason = json?.incomplete_details?.reason || "unknown reason";
    throw new Error(`The AI planner response was incomplete (${reason}). Please try again.`);
  }

  if (typeof json?.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  for (const item of json?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item?.content || []) {
      if (content?.type === "refusal") {
        throw new Error(`The AI planner declined the request${content.refusal ? `: ${content.refusal}` : "."}`);
      }
      if (content?.type === "output_text" && typeof content.text === "string" && content.text.trim()) {
        return content.text.trim();
      }
    }
  }

  throw new Error(`The AI planner returned no usable structured output (status: ${json?.status || "unknown"}).`);
}

async function makePlan(message: string, apiKey: string) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      reasoning: { effort: "none" },
      store: false,
      max_output_tokens: 1200,
      instructions: `You translate user questions into a structured query plan for the California CalGEM WellSTAR wells dataset.

Dataset semantics:
- API is the well API identifier. When the user asks for "API number", "API numbers", "well API", or clearly means the identifier used to identify a well, use field API.
- WellNumber is a separate lease/local well-number field. Only use WellNumber when the user explicitly asks for the WellNumber or local well number.
- OperatorName is the operator.
- WellStatus statuses include Active, Idle, New (present to users as Permitted), Plugged/PluggedOnly, Canceled, and other.
- Locations may be California city boundaries or WellSTAR FieldName, CountyName, District, AreaName, or Place.
- If a user says "Wilmington field", location_type must be field and location_name Wilmington.
- If a user says "Santa Monica" without a qualifier, use location_type auto; California city should be preferred by the application.
- A request to "find", "show", or "map" wells without asking for a list/count is map.
- If they ask for a list, use list or map_and_list. If they also use find/show in a map context, prefer map_and_list.
- If they ask "how many", use count.
- For a list with no explicit columns, include API, WellStatus, OperatorName, and FieldName. If they specifically ask for API numbers, API must be included.
Do not answer the user and do not invent records. Return only the query plan.`,
      input: message,
      text: {
        format: {
          type: "json_schema",
          name: "wellstar_query_plan",
          strict: true,
          schema: PLAN_SCHEMA
        },
        verbosity: "low"
      }
    })
  });

  const json = await response.json();
  if (!response.ok) throw new Error(json.error?.message || `OpenAI request failed with HTTP ${response.status}`);

  const structuredText = extractPlannerText(json);
  try {
    return JSON.parse(structuredText);
  } catch {
    throw new Error("The AI planner returned text that could not be parsed as the expected query plan.");
  }
}

function deterministicMapCommand(plan: any, location: any) {
  const parts = ["Show"];
  if (plan.status) parts.push(String(plan.status).toLowerCase());
  parts.push("wells");
  if (plan.operator) parts.push(`operated by ${plan.operator}`);
  if (location) {
    const suffix = location.kind === "city" ? "city" : location.kind;
    parts.push(`in ${location.label.replace(/\s*\([^)]*County\)$/, "")} ${suffix}`);
  }
  return parts.join(" ");
}

export default async (req: Request) => {
  if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 });

  try {
    const apiKey = Netlify.env.get("OPENAI_API_KEY");
    const body = await req.json();

    if (body?.health === true) {
      return Response.json({
        ok: true,
        api_key_configured: Boolean(apiKey),
        service: "wellstar-ai"
      });
    }

    if (!apiKey) return Response.json({ error: "OPENAI_API_KEY is not configured for this site." }, { status: 503 });

    const message = String(body?.message || "").trim();
    if (!message) return Response.json({ error: "Please enter a question." }, { status: 400 });
    if (message.length > 1200) return Response.json({ error: "Please keep the request under 1,200 characters." }, { status: 400 });

    const plan = await makePlan(message, apiKey);
    const location = await resolveLocation(plan.location_name, plan.location_type);
    if (plan.location_name && !location) {
      return Response.json({
        error: `I understood the location as “${plan.location_name}”, but could not match it to a California city or WellSTAR location field.`,
        plan
      }, { status: 422 });
    }

    const where = buildWhere(plan, location);
    const ids = await matchingIds(where, location);

    let fields = Array.isArray(plan.fields) ? plan.fields.filter((field: string) => WELL_FIELDS.includes(field)) : [];
    if (!fields.length && (plan.action === "list" || plan.action === "map_and_list")) {
      fields = ["API", "WellStatus", "OperatorName", "FieldName"];
    }
    if (fields.includes("API") === false && /\bapi\b/i.test(message)) fields.unshift("API");

    const needRows = plan.action === "list" || plan.action === "map_and_list";
    const rows = needRows ? await fetchRows(ids, fields) : [];

    return Response.json({
      plan,
      resolved_location: location ? { kind: location.kind, label: location.label } : null,
      count: ids.length,
      fields,
      rows,
      truncated: needRows && ids.length > MAX_RETURNED_ROWS,
      row_limit: MAX_RETURNED_ROWS,
      map_command: deterministicMapCommand(plan, location),
      source: "CalGEM WellSTAR"
    });
  } catch (error: any) {
    console.error("WellSTAR AI function failed:", error);
    return Response.json({ error: error?.message || "The AI query failed." }, { status: 500 });
  }
};

export const config = {
  path: "/api/wellstar-ai"
};
