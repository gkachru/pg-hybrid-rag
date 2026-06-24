/**
 * Live smoke test for the attacut Thai segmenter sidecar.
 *
 * Start the service first:
 *   cd examples && podman compose up -d thai-segmenter   # or: docker compose up -d thai-segmenter
 *
 * Run (from repo root):
 *   THAI_SEGMENTER_URL=http://localhost:8100 bun run examples/thai-segmenter/smoke.ts
 */
import { HttpThaiSegmenter } from "../nestjs-thai-segmenter";

const baseUrl = process.env.THAI_SEGMENTER_URL ?? "http://localhost:8100";

async function main(): Promise<void> {
  const seg = new HttpThaiSegmenter({ baseUrl });

  const health = await fetch(`${baseUrl}/health`);
  console.log(`/health → ${health.status} ${JSON.stringify(await health.json())}`);
  if (!health.ok) throw new Error("health check failed");

  // A loanword/brand-heavy product line + a native-vocabulary FAQ line.
  const samples = ["หูฟังไร้สายรุ่น Pro กันน้ำ", "นโยบายการคืนสินค้า"];
  for (const s of samples) {
    const out = await seg.segment(s, "th");
    console.log(`\n  in : ${s}\n  out: ${out}`);
    if (out.replace(/\s+/g, "") !== s.replace(/\s+/g, "")) {
      throw new Error("contract violation: non-whitespace content changed");
    }
  }

  const en = await seg.segment("wireless headphones", "en");
  if (en !== "wireless headphones") throw new Error("non-Thai passthrough failed");

  console.log("\n✓ smoke test passed");
}

main().catch((err) => {
  console.error("\n✗ smoke test failed:", err);
  process.exit(1);
});
