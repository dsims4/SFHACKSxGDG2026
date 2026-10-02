const { compile } = require("html-to-text");

// Content is plain text; links, images, and the original markup have their own
// columns. Keep paragraph/list boundaries without injecting URLs into the text.
const htmlToText = compile({
    wordwrap: false,
    selectors: [
        { selector: "a", options: { ignoreHref: true } },
        ...["img", "script", "style", "iframe", "object", "template", "nav", "form", "[hidden]", "[aria-hidden=true]"]
            .map((selector) => ({ selector, format: "skip" })),
        ...["h1", "h2", "h3", "h4", "h5", "h6"]
            .map((selector) => ({ selector, options: { uppercase: false } }))
    ]
});

function normalizeWhitespace(text) {
    return text.replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/[\t \u00a0]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function fieldText(value, { plainText = false } = {}) {
    if (Array.isArray(value)) {
        return value.map((item) => fieldText(item, { plainText })).filter(Boolean).join("\n\n");
    }
    if (value && typeof value === "object") value = value._;
    if (typeof value !== "string") return "";
    return normalizeWhitespace(plainText ? value : htmlToText(value));
}

function comparisonText(text) {
    return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isHeadlineOnly(text, entry, source) {
    const title = comparisonText(fieldText(entry.title));
    const candidate = comparisonText(text);
    if (!title || !candidate) return false;
    if (candidate === title) return true;

    // Google News describes an item with a linked headline followed by its
    // publisher, sometimes also appending that publisher to the item title.
    for (const publisher of [entry.feedSource, source]) {
        const name = comparisonText(fieldText(publisher));
        if (!name) continue;
        if (candidate === title + name) return true;
        if (title.endsWith(name) && candidate === title.slice(0, -name.length)) return true;
    }
    return false;
}

function atomText(entry, key) {
    const raw = entry[`raw_${key}`]?.[0];
    if (!entry.isAtom || !raw) return fieldText(entry[key]);
    const type = raw.$?.type || "text";
    // Atom text constructs are already XML-decoded by rss-parser. Literal
    // angle brackets in type="text" must not be interpreted as HTML.
    if (type === "text" || type === "text/plain") return fieldText(raw, { plainText: true });
    if (["html", "xhtml", "text/html", "application/xhtml+xml"].includes(type)) {
        return fieldText(entry[key]);
    }
    return ""; // Binary/external media is not an article body.
}

function getContent(entry, { source = "" } = {}) {
    const candidates = [
        fieldText(entry["content:encoded"]),
        atomText(entry, "content"),
        atomText(entry, "summary"),
        fieldText(entry.description),
        fieldText(entry["media:description"]),
        fieldText(entry.itunes?.summary),
        fieldText(entry["content:encodedSnippet"], { plainText: true }),
        entry.isAtom ? "" : fieldText(entry.contentSnippet, { plainText: true })
    ];

    // Test after conversion: a whitespace-only body or tracking image must not
    // hide a useful summary, and title/source wrappers contain no article text.
    return candidates.find((text) => text && !isHeadlineOnly(text, entry, source)) || "";
}

module.exports = { getContent, fieldText };
