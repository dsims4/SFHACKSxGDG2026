const express = require("express");

const articleFields = "e.id::text AS id, s.topic, e.topics, e.title, e.link, e.images, s.summary";
function validID(value) {
    return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
}
function createNewsRouter(database) {
    const router = express.Router();
    router.use((req, res, next) => database ? next() : res.status(503).json({ error: "Database is not configured." }));
    router.get(["/feed", "/topics"], async (req, res) => {
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
            !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
            return res.status(400).json({ error: "date must be a valid YYYY-MM-DD UTC date." });
        }
        const result = await database.query(`SELECT id::text, topic, date::text, summary
            FROM topic_summaries WHERE date BETWEEN $1::date - 1 AND $1::date
                AND date BETWEEN (NOW() AT TIME ZONE 'UTC')::date - 1 AND (NOW() AT TIME ZONE 'UTC')::date
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
                        AND (e.publication_date AT TIME ZONE 'UTC')::date BETWEEN t.date - 1 AND t.date
                        AND e.publication_date >= ((date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day') AT TIME ZONE 'UTC') AND e.publication_date <= NOW()
                        AND ($2::integer IS NULL OR EXISTS (
                        SELECT 1 FROM topic_bullet_articles b
                        WHERE b.topic_summary_id = t.id AND b.article_id = e.id
                            AND b.bullet = $2::integer
                    ))
                    ORDER BY e.publication_date DESC, e.id DESC
                ) article), '[]'::jsonb) AS articles
            FROM topic_summaries t WHERE t.id = $1
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
            FROM topic_summaries t WHERE t.id = $1
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
