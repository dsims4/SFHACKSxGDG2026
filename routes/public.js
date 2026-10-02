const express = require("express");
const { validID } = require("./news");

function safeURL(value) {
    try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
}

function createPublicRouter(database) {
    const router = express.Router();
    router.get("/", async (req, res) => {
        if (!database) return res.status(503).render("index.njk", { topics: [], message: "News is temporarily unavailable." });
        const result = await database.query(`SELECT id::text, topic, date::text, summary
            FROM topic_summaries WHERE date BETWEEN (NOW() AT TIME ZONE 'UTC')::date - 1 AND (NOW() AT TIME ZONE 'UTC')::date ORDER BY date DESC, topic`);
        return res.render("index.njk", { currentPage: "index", topics: result.rows });
    });
    router.get("/topic/:id", async (req, res) => {
        if (!validID(req.params.id)) return res.status(400).send("Invalid topic ID.");
        if (!database) return res.status(503).send("News is temporarily unavailable.");
        const result = await database.query("SELECT id::text, topic, date::text, summary FROM topic_summaries WHERE id = $1 AND date BETWEEN (NOW() AT TIME ZONE 'UTC')::date - 1 AND (NOW() AT TIME ZONE 'UTC')::date", [req.params.id]);
        const topic = result.rows[0];
        if (!topic) return res.status(404).send("Topic not found.");
        const articles = await database.query(`SELECT e.id::text, e.title, e.link, jsonb_path_query_array(CASE WHEN jsonb_typeof(e.images) = 'array' THEN e.images ELSE '[]'::jsonb END, '$[0 to 2]') AS images, e.topics, s.summary
            FROM entries e LEFT JOIN article_summaries s ON s.article_id = e.id
            WHERE $1 = ANY(e.topics) AND (e.publication_date AT TIME ZONE 'UTC')::date BETWEEN $2::date - 1 AND $2::date
                AND e.publication_date >= ((date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '1 day') AT TIME ZONE 'UTC') AND e.publication_date <= NOW()
            ORDER BY e.publication_date DESC, e.id DESC`, [topic.topic, topic.date]);
        return res.render("topic.njk", {
            currentPage: "topic", topic,
            articles: articles.rows.map((article) => ({
                ...article, link: safeURL(article.link),
                images: (Array.isArray(article.images) ? article.images : [])
                    .map((image) => safeURL(typeof image === "string" ? image : image?.url)).filter(Boolean)
            }))
        });
    });
    return router;
}
module.exports = { createPublicRouter, safeURL };
