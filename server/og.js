// Link previews. X and Substack fetch the URL with a plain HTTP GET and read
// meta tags out of the HTML — they run no JavaScript, so the SPA's index.html
// (one empty <div id="root">) previews as nothing. This renders the tags for a
// /c/<resourceId> permalink server-side, into that same index.html.
import { deflateSync } from "node:zlib";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Meta tags for one permalink, injected before </head>. `image` and `url` must
 *  be absolute — a relative og:image is skipped by every crawler. */
export function ogTags({ title, description, url, image }) {
    const t = esc(title), d = esc(description);
    return [
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="SOND3R">`,
        `<meta property="og:url" content="${esc(url)}">`,
        `<meta property="og:title" content="${t}">`,
        `<meta property="og:description" content="${d}">`,
        `<meta property="og:image" content="${esc(image)}">`,
        `<meta property="og:image:width" content="1200">`,
        `<meta property="og:image:height" content="630">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:title" content="${t}">`,
        `<meta name="twitter:description" content="${d}">`,
        `<meta name="twitter:image" content="${esc(image)}">`,
        `<meta name="description" content="${d}">`,
    ].join("\n        ");
}

/** Replace the static <title>/description with this page's, then add the cards. */
export function injectOg(html, { title, ...rest }) {
    return html
        .replace(/<title>[^<]*<\/title>/, `<title>${title === "SOND3R" ? "SOND3R" : `${esc(title)} · SOND3R`}</title>`)
        .replace(/\s*<meta name="description"[^>]*>/, "")
        .replace("</head>", `        ${ogTags({ title, ...rest })}\n    </head>`);
}

// ─── the card image ───────────────────────────────────────────────────────────
// Same seeded blob art the app draws on a file card (src/ui/App.jsx CardArt): the
// bytes are encrypted and unsold, so there is no frame to grab, but the picture
// is stable per resource and two files never look alike.
// ponytail: no text in the image — drawing type means shipping and rasterizing a
// font. The title and price ride in the meta tags, which is where the card puts
// them anyway. Bake a font in if a preview ever needs to stand alone.
const W = 1200, H = 630;
const hashOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const HUE = { video: 212, audio: 268, image: 142, text: 32, application: 18 };

// h 0-360, s/l 0-1 → [r,g,b] 0-255
function hsl(h, s, l) {
    const f = (n) => {
        const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
    const head = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(head));
    return Buffer.concat([len, head, crc]);
};

/** 1200x630 PNG for `seed` (the resourceId), tinted by `mime`'s kind. */
export function ogPng(seed, mime = "video/mp4") {
    const h0 = hashOf(seed);
    const hue = (((HUE[mime.split("/")[0]] ?? 200) + (h0 % 46) - 23) + 360) % 360;
    const bg = hsl(hue, 0.42, 0.11);
    const blobs = [0, 1, 2].map((i) => {
        const b = hashOf(`${seed}#${i}`);
        return {
            // One blob per third of the canvas: three seeded positions on the
            // full width cluster in a corner often enough to look like a bug.
            cx: (10 + i * 30 + (b % 26)) / 100 * W, cy: (12 + ((b >> 7) % 76)) / 100 * H,
            // Bigger and softer than the card's crisp circles: at 1200x630 a
            // hard-edged blob reads as a mistake, a glow reads as artwork.
            rx: (46 + ((b >> 14) % 28)) / 100 * W, ry: (46 + ((b >> 14) % 28)) / 100 * H,
            o: 0.55 + ((b >> 21) % 30) / 100,
            c: hsl((hue + i * 34) % 360, 0.72, 0.58),
        };
    });

    // Raw scanlines, filter byte 0 per row.
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
        let p = y * (W * 3 + 1);
        raw[p++] = 0;
        for (let x = 0; x < W; x++) {
            let [r, g, b] = bg;
            for (const bl of blobs) {
                const dx = (x - bl.cx) / bl.rx, dy = (y - bl.cy) / bl.ry;
                const d = dx * dx + dy * dy;
                if (d > 1) continue;
                const a = bl.o * (1 - d) * (1 - d); // radial falloff
                r += (bl.c[0] - r) * a; g += (bl.c[1] - g) * a; b += (bl.c[2] - b) * a;
            }
            raw[p++] = r; raw[p++] = g; raw[p++] = b;
        }
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolor RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0)),
    ]);
}

// ── self-check: `node server/og.js` ───────────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const html = injectOg(`<!doctype html><html><head><title>SOND3R</title><meta name="description" content="old" /></head><body></body></html>`, {
        title: 'Tilly "the cat" & <friends>.mp4', description: "0.500 USDC", url: "https://app.sond3r.com/c/0xab", image: "https://app.sond3r.com/c/0xab/og.png",
    });
    if (/content="old"/.test(html)) throw new Error("stale static description survived — crawlers read the first one");
    if (/<meta name="description"[^>]*>[\s\S]*<meta name="description"/.test(html)) throw new Error("two descriptions");
    if (!/<title>Tilly &quot;the cat&quot; &amp; &lt;friends&gt;.mp4 · SOND3R<\/title>/.test(html)) throw new Error("title not escaped/replaced");
    if (/content="[^"]*<friends>/.test(html)) throw new Error("unescaped markup in a meta attribute");
    if (!/twitter:card" content="summary_large_image/.test(html)) throw new Error("no twitter card");
    // The unresolved fallback (a slow lookup, a link to something unpublished).
    if (!/<title>SOND3R<\/title>/.test(injectOg("<head><title>x</title></head>", { title: "SOND3R", description: "d", url: "u", image: "i" }))) throw new Error("SOND3R · SOND3R");

    const png = ogPng("0xdeadbeef", "audio/mpeg");
    if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
    if (png.readUInt32BE(16) !== 1200 || png.readUInt32BE(20) !== 630) throw new Error("wrong dimensions");
    if (png.subarray(12, 16).toString() !== "IHDR" || png.subarray(-8, -4).toString() !== "IEND") throw new Error("bad chunk layout");
    if (Buffer.compare(ogPng("0xdeadbeef", "audio/mpeg"), png) !== 0) throw new Error("art must be stable per resource");
    if (Buffer.compare(ogPng("0xfeed", "audio/mpeg"), png) === 0) throw new Error("two resources drew the same picture");
    console.log(`og.js self-check ok — ${png.length} byte card, tags escaped`);
}
