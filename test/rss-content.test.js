const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getContent, fieldText } = require("../rss-builder/content");
const { createFeedParser, fetchSingleFeed } = require("../rss-builder/rss_builder");

test("full RSS content wins over a teaser and preserves readable structure", () => {
    assert.equal(getContent({
        summary: "Short teaser",
        content: "Description",
        "content:encoded": `<h2>Mixed formats</h2><p>First <strong>paragraph</strong> &amp; context.</p>
            <p>Second paragraph with <a href="https://example.com/track">a link</a>.<br>Next line.</p>
            <ul><li>One</li><li>Two</li></ul>`
    }), "Mixed formats\n\nFirst paragraph & context.\n\nSecond paragraph with a link.\nNext line.\n\n* One\n* Two");
});

test("markup-only, missing, and invalid bodies fall back without losing the item", () => {
    for (const value of [undefined, null, 123, {}, [], " \n ", "<p>&nbsp;</p>", '<img src="/photo.jpg" alt="Photo">']) {
        assert.equal(getContent({ "content:encoded": value, content: "<p>Useful description.</p>" }), "Useful description.");
    }
    assert.equal(getContent({ "content:encoded": { _: "<p>Wrapped text</p>" } }), "Wrapped text");
    assert.equal(getContent({ "media:description": [{ _: "Video description", $: { type: "plain" } }] }), "Video description");
    assert.equal(getContent({ itunes: { summary: "Podcast description" } }), "Podcast description");
    assert.equal(getContent({}), "");
});

test("HTML entities, malformed tags, and non-article elements are handled", () => {
    assert.equal(fieldText(`<style>.ad { color: red }</style><script>Paris tracking()</script>
        <nav>Menu</nav><p>Fran&ccedil;ois &amp; &#x4e16;&#x754c;&nbsp; &#8212; news
        <img src="track.gif"><!-- ignored -->
        <iframe>Advertisement</iframe><span hidden>Hidden</span><form>Subscribe</form>`),
    "François & 世界 — news");
    assert.equal(fieldText("<p>2 &lt; 3 &amp; 5 &gt; 4; literal &lt;tag&gt;.</p>"), "2 < 3 & 5 > 4; literal <tag>.");
});

test("the reported Google News wrapper is not treated as article text", async (t) => {
    const title = "Former US congressman sentenced to 10 years for secretly lobbying for Venezuela";
    const link = "https://news.google.com/rss/articles/CBMivgFBVV95cUxOZzVJX09GUERxa1lSRjljOFJYU016bU53RXQxVkNMbjU0RHJpemlQdldUdHkxMW12Qk5YYWFpaWhSMkRfcFRZUVNIOGdacE1aUzhDaGpDSlRibDVrdFZmRmMySUpRTURxSUxLNTFOUlVuVXdFTk1BVC1qanN4OExHaDN0V2xaTVEtR2taYzJ4RGxhaXdYeWNoVjhoeVFIaGhpWjZvVWUyVlJxUXgtLUx2MU13ZWlhQ0ZDeWpncVVR?oc=5";
    const wrapper = `<a href="${link}" target="_blank">${title}</a>&nbsp;&nbsp;<font color="#6f6f6f">Reuters</font>`;
    const xml = `<rss version="2.0"><channel><title>Google News</title><item>
        <title>${title} - Reuters</title><link>${link}</link><pubDate>2026-03-01</pubDate>
        <description><![CDATA[${wrapper}]]></description><source url="https://reuters.com">Reuters</source>
        </item></channel></rss>`;
    t.mock.method(global, "fetch", async () => new Response(xml));
    const result = await fetchSingleFeed({ name: "Reuters", url: "https://news.google.com/rss/search" }, {
        now: new Date("2026-03-02")
    });
    assert.equal(result.error, null);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].content, "");
    assert.equal(result.entries[0].title, title);
    assert.equal(result.entries[0].link, link);
    assert(result.entries[0].item_xml.includes(wrapper));
    assert.equal(getContent({ title, content: wrapper }, { source: "Reuters" }), "");
    assert.equal(getContent({ title, content: wrapper, summary: "Actual reporting from the feed." }, { source: "Reuters" }),
        "Actual reporting from the feed.");
    assert.equal(getContent({ title, content: `${wrapper}<p>Additional facts.</p>` }, { source: "Reuters" }),
        `${title} Reuters\n\nAdditional facts.`);
});

test("Atom HTML, XHTML, literal text, and external media use appropriate fallbacks", async () => {
    const parsed = await createFeedParser().parseString(`<feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom formats</title>
        <entry><title>HTML</title><content type="html">&lt;p&gt;HTML &amp;amp; entities.&lt;/p&gt;</content></entry>
        <entry><title>XHTML</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
            <p>First <b>bold</b> paragraph.</p><p>Second paragraph.</p>
        </div></content></entry>
        <entry><title>Text</title><content type="text">Use &lt;tag&gt; &amp; keep &amp;nbsp; literal.</content></entry>
        <entry><title>Implicit text</title><content>Keep &lt;angle brackets&gt;.</content></entry>
        <entry><title>External</title><content type="video/mp4" src="https://example.com/video.mp4"/>
            <summary type="html">&lt;p&gt;Video summary.&lt;/p&gt;</summary></entry>
        <entry><title>Binary</title><content type="image/png">AAAA</content><summary>Image summary.</summary></entry>
        <entry><title>Binary without summary</title><content type="image/png">AAAA</content></entry>
        <entry><title>Empty HTML</title><content type="html">&lt;img src="track.gif"&gt;</content><summary>Fallback.</summary></entry>
    </feed>`);
    assert.deepEqual(parsed.items.map((entry) => getContent(entry)), [
        "HTML & entities.",
        "First bold paragraph.\n\nSecond paragraph.",
        "Use <tag> & keep &nbsp; literal.",
        "Keep <angle brackets>.",
        "Video summary.",
        "Image summary.",
        "",
        "Fallback."
    ]);
});

test("RSS 1.0 descriptions and content modules are supported", async () => {
    const parsed = await createFeedParser().parseString(`<rdf:RDF
        xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
        xmlns="http://purl.org/rss/1.0/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel rdf:about="https://example.com/feed"><title>News</title></channel>
        <item rdf:about="https://example.com/story"><title>RSS 1</title><description>Teaser.</description>
            <content:encoded><![CDATA[<p>Full RSS 1 article.</p>]]></content:encoded></item>
    </rdf:RDF>`);
    assert.equal(getContent(parsed.items[0]), "Full RSS 1 article.");
});
