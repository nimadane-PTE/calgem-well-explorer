import { enforceAccessRate, registerUser, validEmail, validName } from "../lib/security.mts";

export default async (req: Request) => {
  if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 });

  try {
    const access = await enforceAccessRate(req);
    if (!access.allowed) return Response.json({ error: access.error }, { status: access.status });

    const body = await req.json();
    const name = String(body?.name || "").trim();
    const email = String(body?.email || "").trim();

    if (!validName(name)) {
      return Response.json({ error: "Please enter your full name." }, { status: 400 });
    }
    if (!validEmail(email)) {
      return Response.json({ error: "Please enter a valid email address." }, { status: 400 });
    }
    if (body?.consent !== true) {
      return Response.json({ error: "Please acknowledge the access and usage notice." }, { status: 400 });
    }

    const { token, session } = await registerUser(name, email, req);
    return Response.json({
      ok: true,
      token,
      user: { name: session.name, email: session.email },
      expires_at: new Date(session.exp).toISOString()
    });
  } catch (error: any) {
    console.error("AI access registration failed:", error);
    return Response.json({ error: error?.message || "Access registration failed." }, { status: 500 });
  }
};

export const config = {
  path: "/api/ai-access"
};
