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

import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  Bm25Fts,
  CachingStopWordsLoader,
  CachingSynonymLoader,
  Chunker,
  OpenAiCompatibleEmbedder,
  PostgresRagDatabase,
  RagIndexer,
  RagPipeline,
  type RagResult,
  type RerankerProvider,
  ragMigrate,
  type SqlClient,
  type TransactionProvider,
} from "../src/index.js";

// ── Config (from .env) ──────────────────────────────────────────────────────

function buildDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const db = process.env.POSTGRES_DB;
  if (!user || !password || !db) {
    console.error("Missing required env vars: POSTGRES_USER/PASSWORD/DB (or DATABASE_URL)");
    process.exit(1);
  }
  const host = process.env.POSTGRES_HOST ?? "localhost";
  const port = process.env.POSTGRES_PORT ?? "5432";
  return `postgresql://${user}:${password}@${host}:${port}/${db}`;
}

const DATABASE_URL = buildDatabaseUrl();
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL;
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY ?? process.env.LLM_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL;

if (!EMBEDDING_BASE_URL || !EMBEDDING_API_KEY || !EMBEDDING_MODEL) {
  console.error(
    "Missing required env vars: EMBEDDING_BASE_URL, EMBEDDING_API_KEY (or LLM_API_KEY), EMBEDDING_MODEL",
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
  // Every withConnection reserves one pooled connection for the duration of the
  // callback, so all of its queries share a single session. Both consumers require it:
  //   - search legs apply transaction-local planner GUCs via BEGIN/set_config/COMMIT
  //   - migrations run each file's statements + its tracking-row insert atomically
  // postgres.js rejects a raw BEGIN on a pooled (max>1) connection that isn't reserved,
  // so a non-reserving provider would fail the first search leg with UNSAFE_TRANSACTION.
  const reservingProvider: TransactionProvider = {
    async withConnection<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
      const reserved = await sql.reserve();
      try {
        const client: SqlClient = {
          async query<R = Record<string, unknown>>(text: string, params: unknown[]): Promise<R[]> {
            const result = await reserved.unsafe(text, params as postgres.MaybeRow[]);
            return result as R[];
          },
        };
        return await fn(client);
      } finally {
        reserved.release();
      }
    },
  };

  return { txProvider: reservingProvider, migrationProvider: reservingProvider, sql };
}

// ── Embedder ────────────────────────────────────────────────────────────────

const embedder = new OpenAiCompatibleEmbedder({
  baseUrl: EMBEDDING_BASE_URL,
  apiKey: EMBEDDING_API_KEY,
  model: EMBEDDING_MODEL,
});

// ── Reranker (optional) ───────────────────────────────────────────────────────
// HuggingFace TEI cross-encoder /rerank endpoint. Enabled with --rerank when the
// RERANKER_* env vars are set. The cross-encoder reads candidate text directly — it
// does not use embeddings, so it is independent of the embedding model above.

const RERANKER_BASE_URL = process.env.RERANKER_BASE_URL;
const RERANKER_API_KEY = process.env.RERANKER_API_KEY;

// TEI caps texts per /rerank call (its `max_client_batch_size`, often 8). Sending more
// returns HTTP 422, which surfaces as a reranker failure → silent fallback to RRF order.
// So split candidates into batches, score each, and merge by original index.
const RERANK_BATCH_SIZE = 8;

function createReranker(
  baseUrl: string,
  apiKey?: string,
  batchSize = RERANK_BATCH_SIZE,
): RerankerProvider {
  // Returns scores aligned to the input `texts` order.
  async function scoreBatch(query: string, texts: string[]): Promise<number[]> {
    const res = await fetch(`${baseUrl}/rerank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ query, texts, truncate: true }),
    });
    if (!res.ok) throw new Error(`Reranker error ${res.status}`);
    const ranked = (await res.json()) as Array<{ index: number; score: number }>;
    const scores = new Array<number>(texts.length).fill(0);
    for (const { index, score } of ranked) scores[index] = score;
    return scores;
  }

  return {
    async rerank(query, results, topN) {
      const batches: RagResult[][] = [];
      for (let i = 0; i < results.length; i += batchSize) {
        batches.push(results.slice(i, i + batchSize));
      }
      const batchScores = await Promise.all(
        batches.map((batch) =>
          scoreBatch(
            query,
            batch.map((r) => r.content),
          ),
        ),
      );
      return batches
        .flatMap((batch, bi) => batch.map((r, j) => ({ ...r, score: batchScores[bi][j] })))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);
    },
  };
}

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

// ── Chinese products & FAQs (CJK — use --cjk for pg_bigm bigram keyword search) ──

const PRODUCTS_ZH = [
  {
    id: "00000000-0000-0000-0000-000000000041",
    name: "小米14 Ultra",
    brand: "小米",
    text: `小米14 Ultra旗舰手机。搭载高通骁龙8 Gen 3处理器，6.73英寸2K AMOLED屏幕，峰值亮度3000nit。与徕卡联合研发的专业影像系统，5000万像素主摄配备1英寸大底传感器。

电池：5300mAh，支持90W有线快充和50W无线快充。内存：16GB LPDDR5X。存储：512GB/1TB UFS 4.0。IP68防水防尘。

影像系统：5000万像素徕卡Summilux主摄（f/1.63）、5000万像素超广角、5000万像素长焦（3.2x光学变焦）、5000万像素潜望长焦（5x光学变焦）。支持杜比视界HDR视频录制。

价格：¥6,499起（512GB版本）。颜色：黑色、白色、龙晶蓝。`,
  },
  {
    id: "00000000-0000-0000-0000-000000000042",
    name: "大疆Mini 4 Pro",
    brand: "大疆",
    text: `大疆Mini 4 Pro无人机。249克超轻机身，无需注册即可飞行。搭载1/1.3英寸CMOS传感器，支持4K/60fps HDR视频拍摄和4800万像素照片。

续航：34分钟最长飞行时间。图传：OcuSync 4.0，最远20公里传输距离。避障：全向感知避障系统，APAS 5.0智能避障。

智能功能：焦点跟随、兴趣点环绕、延时摄影、一键短片（渐远、环绕、螺旋、小行星）。支持D-Log M和HLG色彩模式。

价格：¥4,788（标准版）、¥6,188（畅飞套装）。赠送128GB MicroSD卡。`,
  },
];

const FAQ_ZH = [
  {
    id: "00000000-0000-0000-0000-f00000000041",
    text: `退货政策是什么？自签收之日起7天内可无理由退货，15天内可换货。商品必须保持原包装完好，附件齐全。电子产品激活后不支持退货，但可享受官方保修服务。退货运费由买家承担，质量问题除外。`,
  },
  {
    id: "00000000-0000-0000-0000-f00000000042",
    text: `支持哪些付款方式？支持支付宝、微信支付、银联云闪付、信用卡（Visa、Mastercard）和货到付款。满3000元可享6期免息分期，满6000元可享12期免息分期。花呗分期同样适用。`,
  },
];

// ── Japanese products & FAQs (CJK — use --cjk for pg_bigm bigram keyword search) ─

const PRODUCTS_JA = [
  {
    id: "00000000-0000-0000-0000-000000000051",
    name: "象印 炎舞炊き NW-FB10",
    brand: "象印",
    text: `象印 炎舞炊き NW-FB10 IH炊飯ジャー。独自の「炎舞炊き」技術で、まるでかまどで炊いたようなふっくらもちもちのご飯が炊けます。5.5合炊き。

主な機能：豪炎かまどIH、スチームセンサー、豊潤保温（40時間）、タイマー炊飯（2回分）、少量高速炊飯コース。内なべ：「黒まる厚鉄鍋」6層遠赤塗装。

価格：¥44,800。カラー：黒漆・白漆。付属品：しゃもじ・計量カップ。保証期間：本体1年、内なべ3年。`,
  },
  {
    id: "00000000-0000-0000-0000-000000000052",
    name: "カシオ G-SHOCK GW-M5610",
    brand: "カシオ",
    text: `カシオ G-SHOCK GW-M5610 タフソーラー電波時計。世界6局の電波を受信して自動時刻修正。太陽光と室内光で発電するソーラーシステム搭載。電池交換不要。

スペック：耐衝撃構造、20気圧防水、ストップウォッチ（1/100秒）、タイマー、世界時計（31タイムゾーン）、LEDバックライト。サイズ：48.9×43.2×12.7mm、重量：51g。

価格：¥19,800。カラー：ブラック、シルバー、ブルー。保証期間：1年間。電波受信局：日本（60kHz/40kHz）、アメリカ、イギリス、ドイツ、中国。`,
  },
];

const FAQ_JA = [
  {
    id: "00000000-0000-0000-0000-f00000000051",
    text: `返品・交換ポリシーについて。商品到着後8日以内であれば未使用・未開封品に限り返品を承ります。お客様都合の返品は送料お客様負担となります。初期不良・破損の場合は送料当社負担で交換対応いたします。食品・消耗品・デジタルコンテンツは返品不可です。返金は確認後5〜7営業日以内に処理いたします。`,
  },
  {
    id: "00000000-0000-0000-0000-f00000000052",
    text: `ご利用いただける支払い方法。クレジットカード（Visa、Mastercard、JCB、アメックス）、デビットカード、コンビニ払い（セブンイレブン、ローソン、ファミリーマート）、銀行振込、代金引換、PayPay、楽天ペイ、d払いがご利用いただけます。3,000円以上のお買い物でクレジットカードの分割払い（3回・6回・12回）が可能です。`,
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

  const USE_VECTORCHORD = process.argv.includes("--vectorchord");
  const USE_BM25 = process.argv.includes("--bm25");
  const USE_CJK = process.argv.includes("--cjk");
  const USE_RERANK = process.argv.includes("--rerank");

  const reranker =
    USE_RERANK && RERANKER_BASE_URL
      ? createReranker(RERANKER_BASE_URL, RERANKER_API_KEY)
      : undefined;
  if (USE_RERANK && !reranker) {
    console.warn("   --rerank set but RERANKER_BASE_URL is missing; reranking disabled.\n");
  }

  // Step 1: Create isolated database
  console.log(`1. Creating database "${PLAYGROUND_DB}"...`);
  await createPlaygroundDb();
  console.log("   Created.\n");

  const playgroundUrl = withDatabase(DATABASE_URL, PLAYGROUND_DB);
  const { txProvider, migrationProvider, sql } = createAdapter(postgres(playgroundUrl, { max: 5 }));

  try {
    // Step 2: Run migrations (creates tables, indexes, triggers)
    console.log("2. Running migrations...");
    await ragMigrate(migrationProvider, {
      sqlDir: fileURLToPath(new URL("../sql", import.meta.url)),
      vectorchord: USE_VECTORCHORD,
      bm25: USE_BM25,
      cjk: USE_CJK,
    });
    console.log(`   Done. (vectorchord=${USE_VECTORCHORD}, bm25=${USE_BM25}, cjk=${USE_CJK})\n`);

    // Step 3: Seed stop words & synonyms
    console.log("3. Seeding stop words & synonyms...");
    await seedStopWords(sql);
    await seedSynonyms(sql);
    console.log("   Done.\n");

    // Step 4: Index sample products (all languages)
    console.log("4. Indexing products...");
    const db = new PostgresRagDatabase(txProvider, {
      ...(USE_BM25 ? { fts: new Bm25Fts() } : {}),
      ...(USE_CJK ? { cjk: true } : {}),
    });
    const chunker = new Chunker({
      tokenLimit: 512,
      overlap: 75,
      // The label is prepended after sizing and is not counted toward the chunk
      // size limit; keep it short (or leave headroom in tokenLimit) to avoid overflow.
      prefixFn: (m) => (m.brand ? `[${m.name} | ${m.brand}]` : m.name ? `[${m.name}]` : undefined),
    });
    const indexer = new RagIndexer({
      tenantId: TENANT_ID,
      db,
      embedder,
      logger,
    });

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
      ...PRODUCTS_ZH.map((p) => ({ ...p, lang: "zh" })),
      ...PRODUCTS_JA.map((p) => ({ ...p, lang: "ja" })),
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
      ...FAQ_ZH.map((f) => ({ ...f, lang: "zh" })),
      ...FAQ_JA.map((f) => ({ ...f, lang: "ja" })),
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
      ...(reranker ? { reranker } : {}),
    });
    console.log(`   Ready.${reranker ? " (reranker enabled)" : ""}\n`);

    // Step 7: Run test queries (multilingual)
    const queries: Array<{
      q: string;
      lang: string;
      desc: string;
      languages?: string[];
    }> = [
      // English
      {
        q: "best noise cancelling headphones",
        lang: "en",
        desc: "EN semantic",
      },
      { q: "Samsung phone price", lang: "en", desc: "EN keyword + semantic" },
      { q: "return policy", lang: "en", desc: "EN FAQ" },
      {
        q: "cordless vacuum cleaner with laser",
        lang: "en",
        desc: "EN specific feature",
      },
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
      // Chinese (CJK — use --cjk for pg_bigm bigram keyword search)
      { q: "小米手机拍照", lang: "zh", desc: "ZH product search" },
      { q: "无人机续航时间", lang: "zh", desc: "ZH keyword" },
      { q: "退货政策", lang: "zh", desc: "ZH FAQ" },
      { q: "支持微信支付吗", lang: "zh", desc: "ZH FAQ semantic" },
      // Japanese (CJK — use --cjk for pg_bigm bigram keyword search)
      { q: "IH圧力炊飯器", lang: "ja", desc: "JA product keyword" },
      { q: "防水 ソーラー電波時計", lang: "ja", desc: "JA product semantic" },
      { q: "返品できますか", lang: "ja", desc: "JA FAQ keyword" },
      { q: "クレジットカードで支払えますか", lang: "ja", desc: "JA FAQ semantic" },
      // Cross-language (multilingual e5 should handle these)
      { q: "wireless earphones", lang: "en", desc: "EN→HI cross-lang" },
      { q: "coffee beans", lang: "en", desc: "EN→ES cross-lang" },
      { q: "perfume", lang: "en", desc: "EN→AR cross-lang" },
      { q: "drone camera", lang: "en", desc: "EN→ZH cross-lang" },
      // Language-scoped (filter by language)
      {
        q: "battery life",
        lang: "en",
        desc: "EN-only scoped",
        languages: ["en"],
      },
      {
        q: "return policy",
        lang: "en",
        desc: "EN-only FAQ scoped",
        languages: ["en"],
      },
      {
        q: "battery life",
        lang: "en",
        desc: "HI-only scoped",
        languages: ["hi"],
      },
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

    // Step 7b: Reranking cutoff demonstration (only when --rerank is enabled)
    if (reranker) {
      console.log("\n7b. Reranking cutoff demonstration (cross-encoder)\n");
      console.log("   Shows the full reranked score distribution (the relevant/unrelated cliff)");
      console.log("   vs. what survives the default relative cutoff (rerankerMinRelativeScore).\n");
      const rerankDemo = [
        { q: "return policy", lang: "en" },
        { q: "noise cancelling headphones", lang: "en" },
        { q: "how do I cancel an order", lang: "en" },
      ];
      for (const { q, lang } of rerankDemo) {
        console.log(`  Query: "${q}" [${lang}]`);
        console.log(`  ${"─".repeat(76)}`);
        // No cutoff: reveal every reranked candidate's score.
        const all = await pipeline.search(q, {
          topK: 10,
          language: lang,
          candidateMultiplier: 4,
          rerank: true,
          rerankerMinRelativeScore: 0,
        });
        console.log(
          `  Reranked scores (no cutoff): ${all.map((r) => r.score.toExponential(2)).join(", ")}`,
        );
        // Default relative cutoff.
        const kept = await pipeline.search(q, {
          topK: 10,
          language: lang,
          candidateMultiplier: 4,
          rerank: true,
        });
        console.log(`  Kept by default relative cutoff (${kept.length}/${all.length}):`);
        for (const r of kept) {
          const snippet = r.content.slice(0, 80).replace(/\n/g, " ");
          console.log(
            `    [${r.score.toExponential(2)}] ${r.sourceType}/${r.sourceId} — ${snippet}...`,
          );
        }
        console.log("");
      }

      // Off-topic query: nothing in this e-commerce corpus is relevant. The relative cutoff
      // keys off the top score, so it keeps the "best of the garbage". The absolute floor is
      // what actually returns nothing when even the best match is weak.
      console.log("  Off-topic query — exercises rerankerMinAbsoluteScore");
      console.log(`  ${"─".repeat(76)}`);
      const offTopicQ = "how does photosynthesis work in plants";
      // Cast a wide net so unrelated docs still reach the reranker (default vectorMinScore
      // would filter them first, so we'd never see the reranker's verdict).
      const wideNet = {
        topK: 10, // > the reranker's batch size (8) on purpose — exercises batched /rerank calls
        language: "en",
        candidateMultiplier: 4,
        vectorMinScore: 0,
        keywordMinScore: 0,
        rerank: true,
      } as const;
      console.log(`  Query: "${offTopicQ}" [en]`);
      const offAll = await pipeline.search(offTopicQ, { ...wideNet, rerankerMinRelativeScore: 0 });
      console.log(
        `  Reranked scores (no cutoff): ${offAll.map((r) => r.score.toExponential(2)).join(", ")}`,
      );
      const offRel = await pipeline.search(offTopicQ, { ...wideNet });
      console.log(
        `  Relative cutoff only (default 0.01): kept ${offRel.length}/${offAll.length} — best-of-garbage survives`,
      );
      const offAbs = await pipeline.search(offTopicQ, {
        ...wideNet,
        rerankerMinAbsoluteScore: 0.001,
      });
      console.log(
        `  + rerankerMinAbsoluteScore 0.001: kept ${offAbs.length}/${offAll.length} — hard floor drops it all`,
      );
      console.log("");

      console.log(`${"─".repeat(80)}`);
    }

    // Close playground connection before dropping. Bounded timeout: if a search leg
    // errored, hybridSearch's fail-fast Promise.all can reject while sibling legs are
    // still in flight on reserved connections, and a bare sql.end() then waits on them
    // forever. The timeout force-closes so an error surfaces instead of hanging cleanup.
    await sql.end({ timeout: 5 });
  } catch (err) {
    // Ensure the connection is closed even on error (same bounded timeout as above).
    await sql.end({ timeout: 5 }).catch(() => {});
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
    zh: [
      "的",
      "了",
      "在",
      "是",
      "我",
      "有",
      "和",
      "就",
      "不",
      "人",
      "都",
      "一",
      "这",
      "中",
      "大",
      "为",
      "上",
      "个",
      "到",
      "说",
      "们",
      "吗",
      "什么",
      "怎么",
    ],
    ja: [
      "の",
      "は",
      "が",
      "を",
      "に",
      "で",
      "と",
      "から",
      "まで",
      "て",
      "た",
      "な",
      "だ",
      "です",
      "ます",
      "する",
      "した",
      "ある",
      "いる",
      "など",
      "も",
      "や",
      "か",
      "この",
      "その",
      "について",
      "できます",
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
    // Parameterized batch insert ($1..$N) — never interpolate values into SQL,
    // matching seedSynonyms and the rest of the library.
    const placeholders = words
      .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`)
      .join(", ");
    const params = words.flatMap((w) => [TENANT_ID, lang, w]);
    await sql.unsafe(
      `INSERT INTO rag_stop_words (tenant_id, language, word) VALUES ${placeholders}`,
      params,
    );
    total += words.length;
  }
  console.log(`   Seeded ${total} stop words (${Object.keys(stopWords).join(", ")})`);
}

async function seedSynonyms(sql: postgres.Sql) {
  const synonyms: Array<{
    lang: string;
    term: string;
    synonyms: string[];
    direction: string;
  }> = [
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
    {
      lang: "en",
      term: "vacuum",
      synonyms: ["hoover", "vacuum cleaner"],
      direction: "two_way",
    },
    // Hindi
    {
      lang: "hi",
      term: "हेडफ़ोन",
      synonyms: ["ईयरफ़ोन", "नेकबैंड", "ईयरबड्स"],
      direction: "two_way",
    },
    {
      lang: "hi",
      term: "फ़ोन",
      synonyms: ["मोबाइल", "स्मार्टफ़ोन"],
      direction: "two_way",
    },
    {
      lang: "hi",
      term: "कीमत",
      synonyms: ["दाम", "मूल्य", "प्राइस"],
      direction: "two_way",
    },
    // Arabic
    {
      lang: "ar",
      term: "عطر",
      synonyms: ["بخور", "عود", "طيب"],
      direction: "two_way",
    },
    {
      lang: "ar",
      term: "قهوة",
      synonyms: ["كافيه", "بن"],
      direction: "two_way",
    },
    {
      lang: "ar",
      term: "هاتف",
      synonyms: ["جوال", "موبايل", "تلفون"],
      direction: "two_way",
    },
    // Chinese
    {
      lang: "zh",
      term: "手机",
      synonyms: ["智能手机", "移动电话", "手提电话"],
      direction: "two_way",
    },
    {
      lang: "zh",
      term: "无人机",
      synonyms: ["航拍器", "飞行器"],
      direction: "two_way",
    },
    {
      lang: "zh",
      term: "价格",
      synonyms: ["售价", "定价", "多少钱"],
      direction: "two_way",
    },
    // Spanish
    {
      lang: "es",
      term: "café",
      synonyms: ["cafeto", "tinto"],
      direction: "two_way",
    },
    {
      lang: "es",
      term: "envío",
      synonyms: ["despacho", "entrega", "transporte"],
      direction: "two_way",
    },
    {
      lang: "es",
      term: "pago",
      synonyms: ["abono", "cancelación"],
      direction: "two_way",
    },
    // Japanese
    {
      lang: "ja",
      term: "炊飯器",
      synonyms: ["ライスクッカー", "炊飯機", "ご飯炊き"],
      direction: "two_way",
    },
    {
      lang: "ja",
      term: "時計",
      synonyms: ["ウォッチ", "腕時計", "クロック"],
      direction: "two_way",
    },
    {
      lang: "ja",
      term: "価格",
      synonyms: ["値段", "料金", "費用"],
      direction: "two_way",
    },
  ];

  for (const s of synonyms) {
    await sql.unsafe(
      `INSERT INTO rag_synonyms (tenant_id, language, term, synonyms, direction)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [TENANT_ID, s.lang, s.term, JSON.stringify(s.synonyms), s.direction],
    );
  }
  console.log(`   Seeded ${synonyms.length} synonym mappings (en, hi, ar, zh, es, ja)`);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  // Best-effort cleanup on crash
  dropPlaygroundDb()
    .catch(() => {})
    .finally(() => process.exit(1));
});
