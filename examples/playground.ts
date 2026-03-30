/**
 * pg-hybrid-rag playground — exercises the full pipeline against live infra
 * in an isolated database that gets created and dropped automatically.
 *
 * Prerequisites:
 *   - PostgreSQL running (extensions pgvector + pg_trgm available)
 *   - Embedding API accessible
 *
 * Usage:
 *   bun run packages/rag/examples/playground.ts
 *
 * Reads settings from project .env (DATABASE_URL, EMBEDDING_BASE_URL, etc.)
 */

import postgres from "postgres";
import {
  CachingStopWordsLoader,
  CachingSynonymLoader,
  Chunker,
  OpenAiCompatibleEmbedder,
  PostgresRagDatabase,
  RagIndexer,
  RagPipeline,
  ragMigrate,
  type SqlClient,
  type TransactionProvider,
} from "../src/index.js";

// ── Config (from .env) ──────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL;
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY ?? process.env.LLM_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL;

if (!DATABASE_URL || !EMBEDDING_BASE_URL || !EMBEDDING_API_KEY || !EMBEDDING_MODEL) {
  console.error(
    "Missing required env vars: DATABASE_URL, EMBEDDING_BASE_URL, EMBEDDING_API_KEY (or LLM_API_KEY), EMBEDDING_MODEL",
  );
  process.exit(1);
}

const PLAYGROUND_DB = "maxai_rag_playground";
const TENANT_ID = "00000000-0000-0000-0000-000000000099";

// ── DB bootstrap (create/drop isolated database) ────────────────────────────

/** Parse DATABASE_URL and replace the database name. */
function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** Connect to the default DB to run CREATE/DROP DATABASE. */
async function createPlaygroundDb() {
  const admin = postgres(DATABASE_URL, { max: 1 });
  // Drop if leftover from a previous failed run
  await admin.unsafe(`DROP DATABASE IF EXISTS ${PLAYGROUND_DB}`);
  await admin.unsafe(`CREATE DATABASE ${PLAYGROUND_DB}`);
  await admin.end();
}

async function dropPlaygroundDb() {
  const admin = postgres(DATABASE_URL, { max: 1 });
  // Terminate any lingering connections
  await admin.unsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PLAYGROUND_DB}' AND pid <> pg_backend_pid()`,
  );
  await admin.unsafe(`DROP DATABASE IF EXISTS ${PLAYGROUND_DB}`);
  await admin.end();
}

// ── Postgres adapter (postgres.js → SqlClient/TransactionProvider) ──────────

function createAdapter(sql: postgres.Sql) {
  const sqlClient: SqlClient = {
    async query<T = Record<string, unknown>>(text: string, params: unknown[]): Promise<T[]> {
      const result = await sql.unsafe(text, params as postgres.MaybeRow[]);
      return result as T[];
    },
  };

  const txProvider: TransactionProvider = {
    async withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
      return fn(sqlClient);
    },
  };

  return { sqlClient, txProvider, sql };
}

// ── Embedder ────────────────────────────────────────────────────────────────

const embedder = new OpenAiCompatibleEmbedder({
  baseUrl: EMBEDDING_BASE_URL,
  apiKey: EMBEDDING_API_KEY,
  model: EMBEDDING_MODEL,
});

// ── Logger (simple console) ─────────────────────────────────────────────────

const logger = {
  debug: (obj: Record<string, unknown>, msg: string) => console.log("  [debug]", msg, obj),
  info: (obj: Record<string, unknown>, msg: string) => console.log("  [info]", msg, obj),
  warn: (obj: Record<string, unknown>, msg: string) => console.warn("  [warn]", msg, obj),
};

// ── Sample data ─────────────────────────────────────────────────────────────

const PRODUCTS = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Nike Air Max 270",
    brand: "Nike",
    text: `Nike Air Max 270. The Nike Air Max 270 features the tallest Air unit yet for a super-soft ride that feels as great as it looks. The sleek design and lightweight mesh upper provide breathability and all-day comfort.

Key features: Visible Max Air unit in the heel, lightweight mesh upper for breathability, foam midsole for responsive cushioning, rubber outsole with flex grooves.

Available in Black/White, University Red, and Ocean Blue colorways. Price: Rs 12,995. Sizes available: UK 6 to UK 12.`,
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Samsung Galaxy S25 Ultra",
    brand: "Samsung",
    text: `Samsung Galaxy S25 Ultra. The flagship smartphone with a stunning 6.9-inch Dynamic AMOLED 2X display, Snapdragon 8 Elite processor, and an advanced quad-camera system featuring a 200MP main sensor.

Battery: 5000mAh with 45W fast charging. RAM: 12GB. Storage: 256GB/512GB/1TB options. S Pen included with improved latency. IP68 water and dust resistance.

Camera system: 200MP wide, 50MP periscope telephoto (5x), 10MP telephoto (3x), 12MP ultrawide. ProVisual engine for AI-enhanced photography.

Price starting at Rs 1,29,999 for 256GB variant. Available in Titanium Black, Titanium Gray, Titanium Violet, and Titanium Yellow.`,
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    name: "Sony WH-1000XM5",
    brand: "Sony",
    text: `Sony WH-1000XM5 Wireless Noise Cancelling Headphones. Industry-leading noise cancellation with two processors controlling 8 microphones. Exceptional sound quality with 30mm driver units.

Battery life: Up to 30 hours with noise cancelling on. Quick charge: 3 minutes for 3 hours of playback. Multipoint connection for simultaneous pairing with two devices.

Comfort: Ultra-lightweight at 250g, synthetic leather ear pads, adjustable headband. Foldable design for portability. Speak-to-Chat automatically pauses music when you talk.

Touch controls on right ear cup. LDAC codec support for Hi-Res Audio. Adaptive Sound Control learns your behavior.

Price: Rs 29,990. Colors: Black, Silver, Midnight Blue.`,
  },
  {
    id: "00000000-0000-0000-0000-000000000004",
    name: "Apple MacBook Air M3",
    brand: "Apple",
    text: `Apple MacBook Air with M3 chip. Supercharged by the M3 chip with 8-core CPU and up to 10-core GPU. Stunningly thin 11.3mm design weighing just 1.24kg.

Display: 13.6-inch Liquid Retina with P3 wide color, 500 nits brightness, True Tone. Up to 18 hours of battery life. MagSafe charging, two Thunderbolt ports, 3.5mm headphone jack.

Unified memory: 8GB/16GB/24GB options. Storage: 256GB/512GB/1TB/2TB SSD. 1080p FaceTime HD camera with advanced ISP. Six-speaker sound system with Spatial Audio support.

Fanless design — completely silent. macOS Sonoma with Stage Manager and desktop widgets.

Starting at Rs 1,14,900. Available in Midnight, Starlight, Space Gray, and Silver.`,
  },
  {
    id: "00000000-0000-0000-0000-000000000005",
    name: "Dyson V15 Detect",
    brand: "Dyson",
    text: `Dyson V15 Detect Cordless Vacuum Cleaner. A green laser in the fluffy cleaner head reveals microscopic dust on hard floors that other vacuums miss.

Suction power: 230 AW. Five-stage filtration captures 99.99% of particles. Piezo sensor counts and sizes dust particles, displaying real-time data on the LCD screen.

Runtime: Up to 60 minutes in Eco mode with non-motorised tool. Battery: click-in replaceable. HEPA filtration for whole-machine sealed system.

Accessories: High Torque cleaner head, Digital Motorbar cleaner head (anti-tangle), crevice tool, combination tool, mini motorised tool.

Price: Rs 62,900. Includes wall-mounted charging dock.`,
  },
];

// ── Hindi products & FAQs ───────────────────────────────────────────────────

const PRODUCTS_HI = [
  {
    id: "00000000-0000-0000-0000-000000000011",
    name: "बोट रॉकर्ज़ 255 Pro+",
    brand: "boAt",
    text: `बोट रॉकर्ज़ 255 Pro+ वायरलेस नेकबैंड। 60 घंटे की बैटरी लाइफ के साथ लगातार म्यूज़िक सुनें। 12mm ड्राइवर्स से शानदार बेस और क्लियर साउंड मिलता है।

फीचर्स: BEAST मोड लो लेटेंसी गेमिंग के लिए, ENx टेक्नोलॉजी क्लियर कॉल्स के लिए, IPX5 वॉटर रेज़िस्टेंट, मैग्नेटिक इयरबड्स।

कीमत: ₹799। रंग: काला, नीला, हरा। वारंटी: 1 साल।`,
  },
  {
    id: "00000000-0000-0000-0000-000000000012",
    name: "प्रेस्टीज स्वाचh 3.0",
    brand: "Prestige",
    text: `प्रेस्टीज स्वाचh 3.0 इंडक्शन कुकटॉप। 2000 वॉट पावर के साथ तेज़ और ऊर्जा-कुशल खाना पकाना। भारतीय बर्तनों के साथ पूरी तरह संगत।

फीचर्स: ऑटोमैटिक वोल्टेज रेगुलेटर, एंटी-मैग्नेटिक वॉल, प्री-सेट मेनू (रोटी, डोसा, चावल, करी), टाइमर फंक्शन।

कीमत: ₹2,499। वारंटी: 1 साल। फ्री प्रेशर कुकर शामिल।`,
  },
];

const FAQ_HI = [
  {
    id: "00000000-0000-0000-0000-f00000000011",
    text: `क्या मैं ऑर्डर कैंसल कर सकता हूँ? हाँ, आप डिस्पैच से पहले ऑर्डर कैंसल कर सकते हैं। डिस्पैच के बाद कैंसलेशन संभव नहीं है, लेकिन आप डिलीवरी के बाद रिटर्न कर सकते हैं। कैंसलेशन पर रिफंड 5-7 कार्य दिवसों में मिलता है।`,
  },
  {
    id: "00000000-0000-0000-0000-f00000000012",
    text: `EMI कैसे काम करती है? ₹3,000 से ऊपर की खरीदारी पर EMI उपलब्ध है। SBI, HDFC, ICICI कार्ड पर नो-कॉस्ट EMI मिलती है। 3, 6, 9, या 12 महीने की अवधि चुनें। चेकआउट पर EMI विकल्प दिखाई देगा।`,
  },
];

// ── Arabic products & FAQs ──────────────────────────────────────────────────

const PRODUCTS_AR = [
  {
    id: "00000000-0000-0000-0000-000000000021",
    name: "عود العربية الفاخر",
    brand: "Arabian Oud",
    text: `عود العربية الفاخر. عطر شرقي فاخر بمزيج من العود الكمبودي والمسك الأبيض والعنبر. تركيبة غنية تدوم طويلاً على البشرة.

المكونات العلوية: البرغموت والزعفران. قلب العطر: العود الكمبودي وخشب الصندل. القاعدة: المسك الأبيض والعنبر والفانيليا.

الحجم: 100 مل. السعر: 350 ريال. مناسب للمناسبات الخاصة والاستخدام اليومي.`,
  },
  {
    id: "00000000-0000-0000-0000-000000000022",
    name: "دلة القهوة الكهربائية",
    brand: "السيف",
    text: `دلة القهوة الكهربائية من السيف. تحضير القهوة العربية الأصيلة بضغطة زر. سعة 1 لتر تكفي 8 فناجين.

المميزات: نظام تسخين سريع، مؤقت تلقائي، قاعدة دوارة 360 درجة، فلتر قابل للإزالة، مؤشر مستوى الماء.

السعر: 189 ريال. ضمان سنتين. متوفرة باللون الذهبي والفضي.`,
  },
];

const FAQ_AR = [
  {
    id: "00000000-0000-0000-0000-f00000000021",
    text: `ما هي سياسة الإرجاع؟ يمكنك إرجاع أي منتج غير مستخدم خلال 14 يوماً من الاستلام. يجب أن يكون المنتج في عبوته الأصلية. العطور والمنتجات الشخصية غير قابلة للإرجاع بعد الفتح. الشحن مجاني للمنتجات المعيبة.`,
  },
  {
    id: "00000000-0000-0000-0000-f00000000022",
    text: `هل يتوفر الدفع عند الاستلام؟ نعم، الدفع عند الاستلام متاح لجميع الطلبات داخل المملكة. الحد الأقصى للدفع عند الاستلام هو 3000 ريال. كما نقبل بطاقات مدى وفيزا وماستركارد وأبل باي.`,
  },
];

// ── Spanish products & FAQs ─────────────────────────────────────────────────

const PRODUCTS_ES = [
  {
    id: "00000000-0000-0000-0000-000000000031",
    name: "Café Colombiano Premium",
    brand: "Juan Valdez",
    text: `Café Colombiano Premium de Juan Valdez. Granos 100% arábica cultivados a más de 1,800 metros de altitud en la región del Huila. Tostado medio con notas de chocolate oscuro, caramelo y frutas cítricas.

Características: Tueste artesanal en lotes pequeños, empaque con válvula de desgasificación, certificación Rainforest Alliance. Ideal para preparar en cafetera de filtro, prensa francesa o espresso.

Presentación: 500g en grano o molido. Precio: $45.900 COP. Envío gratis en compras superiores a $80.000.`,
  },
  {
    id: "00000000-0000-0000-0000-000000000032",
    name: "Hamaca Artesanal Wayúu",
    brand: "Artesanías de Colombia",
    text: `Hamaca Artesanal Wayúu. Tejida a mano por artesanas de La Guajira con técnicas ancestrales. Cada hamaca es única con patrones geométricos tradicionales llamados kanasü.

Material: Algodón 100% de alta resistencia. Capacidad: hasta 150 kg. Largo total: 3.5 metros. Incluye cuerdas de amarre reforzadas.

Colores disponibles: terracota, azul índigo, verde esmeralda, multicolor. Precio: $289.000 COP. Certificado de origen artesanal incluido.`,
  },
];

const FAQ_ES = [
  {
    id: "00000000-0000-0000-0000-f00000000031",
    text: `¿Cuánto tarda el envío? El envío estándar tarda de 3 a 5 días hábiles dentro de Colombia. Envío express disponible en Bogotá, Medellín y Cali con entrega en 24 horas. Envíos internacionales tardan de 10 a 15 días hábiles. Seguimiento disponible para todos los envíos.`,
  },
  {
    id: "00000000-0000-0000-0000-f00000000032",
    text: `¿Aceptan pagos a cuotas? Sí, ofrecemos pago en cuotas sin interés con tarjetas Bancolombia, Davivienda y BBVA hasta 12 meses. También aceptamos PSE, Nequi, Daviplata y pago contra entrega. El pago contra entrega tiene un recargo de $5.000.`,
  },
];

// ── English FAQs ────────────────────────────────────────────────────────────

const FAQ_ENTRIES = [
  {
    id: "00000000-0000-0000-0000-f00000000001",
    text: `What is your return policy? You can return any unused product within 30 days of purchase for a full refund. The item must be in its original packaging with all tags attached. Opened electronics can be returned within 15 days. Return shipping is free for defective items. For non-defective returns, a flat Rs 99 return shipping fee applies.`,
  },
  {
    id: "00000000-0000-0000-0000-f00000000002",
    text: `How long does delivery take? Standard delivery takes 5-7 business days. Express delivery (Rs 199 extra) delivers within 2-3 business days. Same-day delivery is available in select metro cities for orders placed before 12 PM. All orders above Rs 999 get free standard shipping.`,
  },
  {
    id: "00000000-0000-0000-0000-f00000000003",
    text: `What payment methods do you accept? We accept all major credit and debit cards (Visa, Mastercard, RuPay), UPI payments, net banking, and Cash on Delivery (COD). EMI options available on purchases above Rs 3,000 through select bank cards. No-cost EMI available on select products.`,
  },
];

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n=== pg-hybrid-rag playground ===\n");

  // Step 1: Create isolated database
  console.log(`1. Creating database "${PLAYGROUND_DB}"...`);
  await createPlaygroundDb();
  console.log("   Created.\n");

  const playgroundUrl = withDatabase(DATABASE_URL, PLAYGROUND_DB);
  const { sqlClient, txProvider, sql } = createAdapter(postgres(playgroundUrl, { max: 5 }));

  try {
    // Step 2: Run migrations (creates tables, indexes, triggers)
    console.log("2. Running migrations...");
    await ragMigrate(sqlClient, { sqlDir: new URL("../sql", import.meta.url).pathname });
    console.log("   Done.\n");

    // Step 3: Seed stop words & synonyms
    console.log("3. Seeding stop words & synonyms...");
    await seedStopWords(sql);
    await seedSynonyms(sql);
    console.log("   Done.\n");

    // Step 4: Index sample products (all languages)
    console.log("4. Indexing products...");
    const db = new PostgresRagDatabase(txProvider);
    const chunker = new Chunker({ tokenLimit: 512, overlap: 75 });
    const indexer = new RagIndexer({ tenantId: TENANT_ID, db, embedder, logger });

    const allProducts: Array<{
      id: string;
      name: string;
      brand: string;
      text: string;
      lang: string;
    }> = [
      ...PRODUCTS.map((p) => ({ ...p, lang: "en" })),
      ...PRODUCTS_HI.map((p) => ({ ...p, lang: "hi" })),
      ...PRODUCTS_AR.map((p) => ({ ...p, lang: "ar" })),
      ...PRODUCTS_ES.map((p) => ({ ...p, lang: "es" })),
    ];

    for (const product of allProducts) {
      const chunks = chunker.chunk(product.text, {
        name: product.name,
        brand: product.brand,
        language: product.lang,
      });
      const count = await indexer.index("product", product.id, chunks, product.lang);
      console.log(`   [${product.lang}] Indexed "${product.name}" → ${count} chunks`);
    }

    // Step 5: Index FAQs (all languages)
    console.log("\n5. Indexing FAQs...");
    const allFaqs: Array<{ id: string; text: string; lang: string }> = [
      ...FAQ_ENTRIES.map((f) => ({ ...f, lang: "en" })),
      ...FAQ_HI.map((f) => ({ ...f, lang: "hi" })),
      ...FAQ_AR.map((f) => ({ ...f, lang: "ar" })),
      ...FAQ_ES.map((f) => ({ ...f, lang: "es" })),
    ];

    for (const faq of allFaqs) {
      const chunks = chunker.chunk(faq.text, { language: faq.lang });
      const count = await indexer.index("faq", faq.id, chunks, faq.lang);
      console.log(`   [${faq.lang}] Indexed FAQ ${faq.id} → ${count} chunks`);
    }

    // Step 6: Build the search pipeline
    console.log("\n6. Setting up search pipeline...");
    const stopWords = new CachingStopWordsLoader({ txProvider });
    const synonyms = new CachingSynonymLoader({ txProvider });
    const pipeline = new RagPipeline({
      tenantId: TENANT_ID,
      db,
      embedder,
      stopWords,
      synonyms,
      logger,
    });
    console.log("   Ready.\n");

    // Step 7: Run test queries (multilingual)
    const queries: Array<{ q: string; lang: string; desc: string; languages?: string[] }> = [
      // English
      { q: "best noise cancelling headphones", lang: "en", desc: "EN semantic" },
      { q: "Samsung phone price", lang: "en", desc: "EN keyword + semantic" },
      { q: "return policy", lang: "en", desc: "EN FAQ" },
      { q: "cordless vacuum cleaner with laser", lang: "en", desc: "EN specific feature" },
      // Hindi
      { q: "वायरलेस नेकबैंड बैटरी", lang: "hi", desc: "HI product search" },
      { q: "इंडक्शन कुकटॉप कीमत", lang: "hi", desc: "HI keyword" },
      { q: "ऑर्डर कैंसल कैसे करें", lang: "hi", desc: "HI FAQ" },
      { q: "EMI कैसे मिलेगी", lang: "hi", desc: "HI FAQ semantic" },
      // Arabic
      { q: "عطر عود فاخر", lang: "ar", desc: "AR product search" },
      { q: "دلة قهوة كهربائية", lang: "ar", desc: "AR keyword" },
      { q: "سياسة الإرجاع", lang: "ar", desc: "AR FAQ" },
      { q: "هل يتوفر الدفع عند الاستلام", lang: "ar", desc: "AR FAQ semantic" },
      // Spanish
      { q: "café colombiano arábica", lang: "es", desc: "ES product search" },
      { q: "hamaca artesanal tejida", lang: "es", desc: "ES keyword" },
      { q: "cuánto tarda el envío", lang: "es", desc: "ES FAQ" },
      { q: "pago en cuotas sin interés", lang: "es", desc: "ES FAQ semantic" },
      // Cross-language (multilingual e5 should handle these)
      { q: "wireless earphones", lang: "en", desc: "EN→HI cross-lang" },
      { q: "coffee beans", lang: "en", desc: "EN→ES cross-lang" },
      { q: "perfume", lang: "en", desc: "EN→AR cross-lang" },
      // Language-scoped (filter by language)
      { q: "battery life", lang: "en", desc: "EN-only scoped", languages: ["en"] },
      { q: "return policy", lang: "en", desc: "EN-only FAQ scoped", languages: ["en"] },
      { q: "battery life", lang: "en", desc: "HI-only scoped", languages: ["hi"] },
    ];

    console.log("7. Running search queries...\n");
    console.log("─".repeat(80));

    for (const { q, lang, desc, languages } of queries) {
      const scopeLabel = languages ? ` scope=${languages.join(",")}` : "";
      console.log(`\n  Query: "${q}" [${lang}${scopeLabel}] (${desc})`);
      console.log(`  ${"─".repeat(76)}`);

      const start = performance.now();
      const results = await pipeline.search(q, {
        topK: 3,
        language: lang,
        languages,
      });
      const elapsed = (performance.now() - start).toFixed(1);

      if (results.length === 0) {
        console.log(`  No results (${elapsed}ms)`);
      } else {
        for (const r of results) {
          const snippet = r.content.slice(0, 100).replace(/\n/g, " ");
          console.log(`  [${r.score.toFixed(3)}] ${r.sourceType}/${r.sourceId} — ${snippet}...`);
        }
        console.log(`  (${results.length} results in ${elapsed}ms)`);
      }
    }

    console.log(`\n${"─".repeat(80)}`);

    // Close playground connection before dropping
    await sql.end();
  } catch (err) {
    // Ensure connection is closed even on error
    await sql.end().catch(() => {});
    throw err;
  }

  // Step 8: Drop the playground database
  console.log(`\n8. Dropping database "${PLAYGROUND_DB}"...`);
  await dropPlaygroundDb();
  console.log("   Dropped.\n");

  console.log("=== Done ===\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function seedStopWords(sql: postgres.Sql) {
  const stopWords: Record<string, string[]> = {
    en: [
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "and",
      "or",
      "but",
      "it",
      "its",
      "this",
      "that",
      "my",
      "me",
      "i",
      "do",
      "does",
      "can",
      "what",
      "how",
      "which",
      "your",
      "you",
      "we",
      "they",
      "have",
      "has",
    ],
    hi: [
      "का",
      "के",
      "की",
      "में",
      "है",
      "हैं",
      "को",
      "से",
      "पर",
      "और",
      "या",
      "एक",
      "यह",
      "वह",
      "मैं",
      "हम",
      "तुम",
      "आप",
      "कि",
      "भी",
      "तो",
      "ही",
      "नहीं",
      "कैसे",
      "क्या",
      "कौन",
      "कहाँ",
      "कब",
      "मेरा",
      "मेरी",
      "अपना",
      "अपनी",
    ],
    ar: [
      "في",
      "من",
      "على",
      "إلى",
      "هل",
      "ما",
      "هذا",
      "هذه",
      "أن",
      "و",
      "أو",
      "لا",
      "هو",
      "هي",
      "نحن",
      "هم",
      "كل",
      "بعد",
      "قبل",
      "عن",
      "مع",
      "ذلك",
      "التي",
      "الذي",
    ],
    es: [
      "el",
      "la",
      "los",
      "las",
      "un",
      "una",
      "de",
      "en",
      "con",
      "por",
      "para",
      "y",
      "o",
      "que",
      "es",
      "son",
      "del",
      "al",
      "se",
      "no",
      "su",
      "más",
      "como",
      "pero",
      "este",
      "esta",
      "qué",
      "cómo",
      "cuánto",
    ],
  };

  let total = 0;
  for (const [lang, words] of Object.entries(stopWords)) {
    const values = words.map((w) => `('${TENANT_ID}', '${lang}', '${w}')`).join(", ");
    await sql.unsafe(`INSERT INTO rag_stop_words (tenant_id, language, word) VALUES ${values}`);
    total += words.length;
  }
  console.log(`   Seeded ${total} stop words (${Object.keys(stopWords).join(", ")})`);
}

async function seedSynonyms(sql: postgres.Sql) {
  const synonyms: Array<{ lang: string; term: string; synonyms: string[]; direction: string }> = [
    // English
    {
      lang: "en",
      term: "phone",
      synonyms: ["smartphone", "mobile", "cellphone"],
      direction: "two_way",
    },
    {
      lang: "en",
      term: "laptop",
      synonyms: ["notebook", "macbook", "ultrabook"],
      direction: "two_way",
    },
    {
      lang: "en",
      term: "headphones",
      synonyms: ["earphones", "headset", "earbuds"],
      direction: "two_way",
    },
    {
      lang: "en",
      term: "shoes",
      synonyms: ["sneakers", "trainers", "footwear"],
      direction: "two_way",
    },
    { lang: "en", term: "vacuum", synonyms: ["hoover", "vacuum cleaner"], direction: "two_way" },
    // Hindi
    { lang: "hi", term: "हेडफ़ोन", synonyms: ["ईयरफ़ोन", "नेकबैंड", "ईयरबड्स"], direction: "two_way" },
    { lang: "hi", term: "फ़ोन", synonyms: ["मोबाइल", "स्मार्टफ़ोन"], direction: "two_way" },
    { lang: "hi", term: "कीमत", synonyms: ["दाम", "मूल्य", "प्राइस"], direction: "two_way" },
    // Arabic
    { lang: "ar", term: "عطر", synonyms: ["بخور", "عود", "طيب"], direction: "two_way" },
    { lang: "ar", term: "قهوة", synonyms: ["كافيه", "بن"], direction: "two_way" },
    { lang: "ar", term: "هاتف", synonyms: ["جوال", "موبايل", "تلفون"], direction: "two_way" },
    // Spanish
    { lang: "es", term: "café", synonyms: ["cafeto", "tinto"], direction: "two_way" },
    {
      lang: "es",
      term: "envío",
      synonyms: ["despacho", "entrega", "transporte"],
      direction: "two_way",
    },
    { lang: "es", term: "pago", synonyms: ["abono", "cancelación"], direction: "two_way" },
  ];

  for (const s of synonyms) {
    await sql.unsafe(
      `INSERT INTO rag_synonyms (tenant_id, language, term, synonyms, direction)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [TENANT_ID, s.lang, s.term, JSON.stringify(s.synonyms), s.direction],
    );
  }
  console.log(`   Seeded ${synonyms.length} synonym mappings (en, hi, ar, es)`);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  // Best-effort cleanup on crash
  dropPlaygroundDb()
    .catch(() => {})
    .finally(() => process.exit(1));
});
