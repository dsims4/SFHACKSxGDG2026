const express = require("express");

const articleFields = "e.id::text AS id, s.topic, e.topics, e.title, e.source AS publisher, e.publication_date, e.link, jsonb_path_query_array(CASE WHEN jsonb_typeof(e.images) = 'array' THEN e.images ELSE '[]'::jsonb END, '$[0 to 2]') AS images, s.summary";
function validID(value) {
    return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
function createNewsRouter(database) {
    const router = express.Router();
    router.use((req, res, next) => database ? next() : res.status(503).json({ error: "Database is not configured." }));
    router.get("/globe/articles", async (req, res) => {
        const { name = "", country = "", level, lat, lng, topic = "all", hours = "48", offset = "0" } = req.query;
        if (![name, country, level, lat, lng, topic, hours, offset].every((value) => typeof value === "string") ||
            name.length > 200 || country.length > 200 || !["city", "country"].includes(level) ||
            !lat.trim() || !lng.trim() || !Number.isFinite(Number(lat)) || Math.abs(Number(lat)) > 90 ||
            !Number.isFinite(Number(lng)) || Math.abs(Number(lng)) > 180 ||
            !/^(all|economics|environment|politics|technology|science|health|business|sports|culture|world)$/.test(topic) ||
            !["24", "48"].includes(hours) || !/^[0-9]{1,6}$/.test(offset)) {
            return res.status(400).json({ error: "Invalid location, topic, date range or offset." });
        }
        const end = new Date();
        const start = new Date(end.getTime() - Number(hours) * 3600000);
        const result = await database.query(`SELECT ${articleFields}
            FROM entries e LEFT JOIN article_summaries s ON s.article_id = e.id
            WHERE e.has_location = TRUE AND cardinality(e.topics) > 0
                AND COALESCE(e.location_name, '') = $1 AND COALESCE(e.location_country, '') = $2
                AND e.location_level = $3 AND e.location_lat = $4 AND e.location_lng = $5
                AND ($6 = 'all' OR $6 = ANY(e.topics))
                AND e.publication_date >= $7 AND e.publication_date <= $8
            ORDER BY e.publication_date DESC, e.id DESC LIMIT 51 OFFSET $9
        `, [name, country, level, Number(lat), Number(lng), topic, start.toISOString(), end.toISOString(), Number(offset)]);
        return res.json({ articles: result.rows.slice(0, 50), next_offset: result.rows.length > 50 ? Number(offset) + 50 : null });
    });
    router.get("/globe", async (req, res) => {
        const hours = req.query.hours === undefined ? "48" : req.query.hours;
        if (typeof hours !== "string" || !["24", "48"].includes(hours)) {
            return res.status(400).json({ error: "hours must be 24 or 48." });
        }
        // Count each article once, preserving its complete set of labels. Expanding
        // topics here would double-count multi-label articles in the all-topics view.
        const end = new Date();
        const start = new Date(end.getTime() - Number(hours) * 3600000);
        const result = await database.query(`
            SELECT location_name AS name, location_country AS country,
                location_level AS level, location_lat AS lat, location_lng AS lng,
                topics, COUNT(*)::integer AS count
            FROM entries
            WHERE has_location = TRUE AND cardinality(topics) > 0
                AND location_lat BETWEEN -90 AND 90
                AND location_lng BETWEEN -180 AND 180
                AND publication_date >= $1 AND publication_date <= $2
            GROUP BY location_name, location_country, location_level,
                location_lat, location_lng, topics
            ORDER BY count DESC, location_name, topics
        `, [start.toISOString(), end.toISOString()]);
        res.set("Cache-Control", "public, max-age=60");
        return res.json({ mode: "live", start: start.toISOString(), end: end.toISOString(), locations: result.rows });
    });
    router.get(["/feed", "/topics"], async (req, res) => {
        const date = req.query.date || new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
            !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
            return res.status(400).json({ error: "date must be a valid YYYY-MM-DD Pacific date." });
        }
        const result = await database.query(`SELECT id::text, topic, date::text, summary
            FROM topic_summaries WHERE date = $1::date AND source_window_days = 1
                AND date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date
            ORDER BY date DESC, topic`, [date]);
        if (req.path === "/feed") {
            return res.json({ date, cards: result.rows.map((row) => ({
                id: row.id, topic: row.topic, date: row.date,
                events: row.summary.map((text, index) => ({ event: index + 1, text }))
            })) });
        }
        return res.json({ date, topics: result.rows.map((row) => ({
            id: row.id, topic: row.topic, date: row.date,
            bullets: row.summary.map((text, index) => ({ bullet: index + 1, text }))
        })) });
    });
    router.get("/topics/:id", async (req, res) => {
        const event = req.query.event;
        if (!validID(req.params.id) || (event !== undefined &&
            (typeof event !== "string" || !/^[1-5]$/.test(event)))) {
            return res.status(400).json({ error: "Invalid topic ID or event number (1–5)." });
        }
        // EXISTS avoids duplicate articles cited by more than one event.
        const result = await database.query(`
            SELECT t.id::text, t.topic, t.date::text, t.summary,
                COALESCE((SELECT jsonb_agg(article) FROM (
                    SELECT ${articleFields} FROM entries e
                    JOIN article_summaries s ON s.article_id = e.id
                    WHERE t.topic = ANY(e.topics)
                        AND (e.publication_date AT TIME ZONE 'America/Los_Angeles')::date = t.date
                        AND e.publication_date >= (date_trunc('day', NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles') AND e.publication_date <= NOW()
                        AND ($2::integer IS NULL OR EXISTS (
                        SELECT 1 FROM topic_bullet_articles b
                        WHERE b.topic_summary_id = t.id AND b.article_id = e.id
                            AND b.bullet = $2::integer
                    ))
                    ORDER BY e.publication_date DESC, e.id DESC
                ) article), '[]'::jsonb) AS articles
            FROM topic_summaries t WHERE t.id = $1 AND t.source_window_days = 1 AND t.date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date
        `, [req.params.id, event === undefined ? null : Number(event)]);
        if (!result.rows.length) return res.status(404).json({ error: "Topic summary not found." });
        const row = result.rows[0];
        return res.json({
            ...row,
            events: row.summary.map((text, index) => ({ event: index + 1, text })),
            selected_event: event === undefined ? null : Number(event)
        });
    });
    router.get("/topics/:id/bullets/:bullet/articles", async (req, res) => {
        if (!validID(req.params.id) || !/^[1-5]$/.test(req.params.bullet)) return res.status(400).json({ error: "Invalid topic ID or bullet number." });
        // One statement gives a consistent snapshot of bullet text and its citations.
        const result = await database.query(`
            SELECT t.id::text, t.topic, t.date::text, t.summary ->> ($2::integer - 1) AS text,
                COALESCE((SELECT jsonb_agg(article) FROM (
                    SELECT ${articleFields} FROM topic_bullet_articles b
                    JOIN entries e ON e.id = b.article_id
                    JOIN article_summaries s ON s.article_id = e.id
                    WHERE b.topic_summary_id = t.id AND b.bullet = $2::integer ORDER BY e.id
                ) article), '[]'::jsonb) AS articles
            FROM topic_summaries t WHERE t.id = $1 AND t.source_window_days = 1 AND t.date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date
        `, [req.params.id, req.params.bullet]);
        if (!result.rows.length) return res.status(404).json({ error: "Topic summary not found." });
        return res.json({ ...result.rows[0], bullet: Number(req.params.bullet) });
    });
    router.get("/articles/:id", async (req, res) => {
        if (!validID(req.params.id)) return res.status(400).json({ error: "Invalid article ID." });
        const result = await database.query(`SELECT ${articleFields} FROM entries e
            LEFT JOIN article_summaries s ON s.article_id = e.id WHERE e.id = $1`, [req.params.id]);
        if (!result.rows.length) return res.status(404).json({ error: "Article not found." });
        return res.json(result.rows[0]);
    });
    return router;
}
module.exports = { createNewsRouter, validID };
