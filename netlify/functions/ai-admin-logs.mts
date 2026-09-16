import { adminAuthorized, securityStore } from "../lib/security.mts";

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

export default async (req: Request) => {
  if (!adminAuthorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Response.json({ error: "Use date=YYYY-MM-DD." }, { status: 400 });
    }

    const store = securityStore();
    const listed = await store.list({ prefix: `events/${date}/` }) as any;
    const keys = (listed?.blobs || []).map((item: any) => item.key).sort();
    const rows = [];
    for (const key of keys.slice(-2000)) {
      const row = await store.get(key, { type: "json" });
      if (row) rows.push(row);
    }

    const format = url.searchParams.get("format") || "json";
    if (format === "csv") {
      const columns = ["timestamp", "type", "status", "name", "email", "sessionId", "ipHash", "message"];
      const lines = [columns.join(",")];
      for (const row of rows) lines.push(columns.map((column) => csvEscape(row?.[column])).join(","));
      return new Response(lines.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="wellstar-ai-usage-${date}.csv"`
        }
      });
    }

    return Response.json({ date, count: rows.length, rows });
  } catch (error: any) {
    console.error("AI admin log retrieval failed:", error);
    return Response.json({ error: error?.message || "Could not retrieve logs." }, { status: 500 });
  }
};

export const config = {
  path: "/api/ai-admin-logs"
};
