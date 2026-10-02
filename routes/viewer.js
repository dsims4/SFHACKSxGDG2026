const express = require("express");

const PAGE_SIZE = 25;
const MAX_PAGE = 10000;
const SORTS = {
    published: { sql: "publication_date", label: "Published", defaultDir: "desc" },
    source: { sql: "source", label: "Source", defaultDir: "asc" },
    title: { sql: "title", label: "Title", defaultDir: "asc" },
    location: { sql: "location_name", label: "Location", defaultDir: "asc" }
};

function parseViewerQuery(query) {
    const rawPage = Number.parseInt(query.page ?? "1", 10);
    const page = Number.isInteger(rawPage) && rawPage > 0
        ? Math.min(rawPage, MAX_PAGE)
        : 1;
    const q = typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
    const requestedSort = typeof query.sort === "string" ? query.sort : "";
    const sort = Object.hasOwn(SORTS, requestedSort) ? requestedSort : "published";
    const defaultDir = SORTS[sort].defaultDir;
    const dir = query.dir === "asc" || query.dir === "desc" ? query.dir : defaultDir;

    return { page, q, sort, dir };
}

function storyHref({ q, sort, dir, page }) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (sort !== "published") params.set("sort", sort);
    if (dir !== SORTS[sort].defaultDir) params.set("dir", dir);
    if (page > 1) params.set("page", String(page));
    const text = params.toString();
    return text ? `/viewer?${text}` : "/viewer";
}

function storyColumns({ q, sort, dir }) {
    return Object.entries(SORTS).map(([key, column]) => {
        const active = key === sort;
        const nextDir = active ? (dir === "asc" ? "desc" : "asc") : column.defaultDir;
        return {
            key,
            label: column.label,
            href: storyHref({ q, sort: key, dir: nextDir, page: 1 }),
            ariaSort: active ? (dir === "asc" ? "ascending" : "descending") : "none",
            marker: active ? (dir === "asc" ? "↑" : "↓") : ""
        };
    });
}

function likePattern(value) {
    return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function safeLink(link) {
    if (typeof link !== "string") return null;

    try {
        const url = new URL(link);
        if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
        return null;
    }

    return null;
}

async function listEntries(pool, query) {
    const { page, q, sort, dir } = parseViewerQuery(query);
    const pattern = q ? likePattern(q) : null;
    const where = pattern
        ? `WHERE title ILIKE $1 ESCAPE '\\'
            OR source ILIKE $1 ESCAPE '\\'
            OR COALESCE(link, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(location_name, '') ILIKE $1 ESCAPE '\\'
            OR COALESCE(location_country, '') ILIKE $1 ESCAPE '\\'
            OR content ILIKE $1 ESCAPE '\\'`
        : "";
    const filters = pattern ? [pattern] : [];
    const count = await pool.query(
        `SELECT COUNT(*)::int AS total FROM entries ${where}`,
        filters
    );
    const total = count.rows[0].total;
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const currentPage = Math.min(page, pageCount);
    const rows = await pool.query(`
        SELECT id, title, LEFT(content, 400) AS content, source,
               publication_date, link, location_name, location_country
        FROM entries
        ${where}
        ORDER BY ${SORTS[sort].sql} ${dir.toUpperCase()} NULLS LAST, id DESC
        LIMIT $${filters.length + 1} OFFSET $${filters.length + 2}
    `, [...filters, PAGE_SIZE, (currentPage - 1) * PAGE_SIZE]);

    return {
        entries: rows.rows.map((row) => ({
            id: String(row.id),
            title: row.title || "(untitled)",
            content: row.content || "",
            source: row.source,
            published: row.publication_date instanceof Date
                ? row.publication_date.toISOString()
                : String(row.publication_date ?? ""),
            link: safeLink(row.link),
            location: [row.location_name, row.location_country].filter(Boolean).join(", ")
        })),
        total,
        page: currentPage,
        pageSize: PAGE_SIZE,
        pageCount,
        q,
        sort,
        dir,
        columns: storyColumns({ q, sort, dir }),
        prevHref: storyHref({ q, sort, dir, page: currentPage - 1 }),
        nextHref: storyHref({ q, sort, dir, page: currentPage + 1 })
    };
}

function createViewerRouter(pool) {
    const router = express.Router();

    router.get("/viewer", async (req, res) => {
        const query = parseViewerQuery(req.query);

        if (!pool) {
            return res.render("viewer.njk", {
                currentPage: "viewer",
                unavailable: "PostgreSQL is not configured. Set DATABASE_URL to view stored stories.",
                entries: [],
                total: 0,
                pageCount: 1,
                ...query
            });
        }

        try {
            const result = await listEntries(pool, query);
            return res.render("viewer.njk", {
                currentPage: "viewer",
                unavailable: null,
                ...result
            });
        } catch (error) {
            console.error("Viewer query failed:", error.message);
            const missingTable = error.code === "42P01";
            return res.status(503).render("viewer.njk", {
                currentPage: "viewer",
                unavailable: missingTable
                    ? "The entries table does not exist yet. It is created when the RSS worker connects."
                    : "The database could not be read.",
                entries: [],
                total: 0,
                pageCount: 1,
                ...query
            });
        }
    });

    return router;
}

module.exports = {
    PAGE_SIZE,
    parseViewerQuery,
    likePattern,
    storyHref,
    listEntries,
    createViewerRouter
};
