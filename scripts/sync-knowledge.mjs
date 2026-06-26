import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const root = path.resolve(new URL("../", import.meta.url).pathname);
loadDotEnv(path.join(root, ".env"));

const uri = process.env.MONGODB_URI;
const dbName = process.env.KNOWLEDGE_DB_NAME || "hajimi";
const outputPath = process.env.KNOWLEDGE_CACHE_PATH || path.join(root, "data", "knowledge-cache.json");

if (!uri) {
  console.error("Missing MONGODB_URI in .env");
  process.exit(1);
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

try {
  await client.connect();
  const db = client.db(dbName);

  const [knowledgeUnits, trainingData, venueRules, templates, knowledgeBase] = await Promise.all([
    db
      .collection("knowledge_units")
      .find({ enabled: { $ne: false } })
      .project({ embedding: 0 })
      .toArray(),
    db.collection("training_data").find({}).toArray(),
    db.collection("venue_rules").find({}).toArray(),
    db.collection("templates").find({}).toArray(),
    db.collection("knowledge_base").find({}).toArray(),
  ]);

  const payload = {
    syncedAt: new Date().toISOString(),
    dbName,
    collections: {
      knowledge_units: knowledgeUnits.map(serializable),
      training_data: trainingData.map(serializable),
      venue_rules: venueRules.map(serializable),
      templates: templates.map(serializable),
      knowledge_base: knowledgeBase.map(serializable),
    },
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputPath,
        syncedAt: payload.syncedAt,
        counts: Object.fromEntries(
          Object.entries(payload.collections).map(([name, docs]) => [name, docs.length]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await client.close().catch(() => {});
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ||= value;
  }
}

function serializable(doc) {
  return JSON.parse(
    JSON.stringify(doc, (_key, value) => {
      if (value && typeof value === "object" && value._bsontype === "ObjectId") {
        return value.toString();
      }
      return value;
    }),
  );
}
