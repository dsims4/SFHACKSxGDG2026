const express = require("express");

const MAX_PAGE = 10000;
const PAGE_SIZES = new Set([10, 25, 50, 100]);
const SORTS = {
    date_desc: "publication_date DESC NULLS LAST, id DESC",
    date_asc: "publication_date ASC NULLS LAST, id ASC",
    source_asc: "source ASC, publication_date DESC",
    id_desc: "id DESC"
};

function parseDateOnly(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
        ? ""
        : value;
}

function parseDbViewerQuery(query) {
    const rawPage = Number.parseInt(query.page ?? "1", 10);
    const page = Number.isInteger(rawPage) && rawPage > 0
        ? Math.min(rawPage, MAX_PAGE)
        : 1;
    const q = typeof query.q === "string" ? query.q.trim().slice(0, 200) : "";
    const source = typeof query.source === "string" ? query.source.trim().slice(0, 200) : "";
    const rawSize = Number.parseInt(query.perPage ?? "25", 10);
    const sort = Object.hasOwn(SORTS, query.sort) ? query.sort : "date_desc";

    return {
        page,
        q,
        source,
        start: parseDateOnly(query.start),
        end: parseDateOnly(query.end),
        hasLocation: query.hasLocation === "true" || query.hasLocation === "false"
            ? query.hasLocation
            : "",
        sort,
        perPage: PAGE_SIZES.has(rawSize) ? rawSize : 25
    };
}

function buildFilters(query) {
    const conditions = ["TRUE"];
    const params = [];

    if (query.q) {
        params.push(query.q);
        const marker = `$${params.length}`;
        conditions.push(`(
            position(lower(${marker}::text) in lower(coalesce(title, ''))) > 0 OR
            position(lower(${marker}::text) in lower(coalesce(content, ''))) > 0 OR
            position(lower(${marker}::text) in lower(coalesce(source, ''))) > 0 OR
            position(lower(${marker}::text) in lower(coalesce(location_name, ''))) > 0 OR
            position(lower(${marker}::text) in lower(coalesce(location_country, ''))) > 0
        )`);
    }

    if (query.source) {
        params.push(query.source);
        conditions.push(`source = $${params.length}`);
    }

    if (query.start) {
        params.push(query.start);
        conditions.push(`publication_date::date >= $${params.length}::date`);
    }

    if (query.end) {
        params.push(query.end);
        conditions.push(`publication_date::date <= $${params.length}::date`);
    }

    if (query.hasLocation === "true") conditions.push("has_location = TRUE");
    if (query.hasLocation === "false") {
        conditions.push("(has_location = FALSE OR has_location IS NULL)");
    }

    return { where: conditions.join(" AND "), params };
}

function viewerHref(query, page) {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.source) params.set("source", query.source);
    if (query.start) params.set("start", query.start);
    if (query.end) params.set("end", query.end);
    if (query.hasLocation) params.set("hasLocation", query.hasLocation);
    if (query.sort !== "date_desc") params.set("sort", query.sort);
    if (query.perPage !== 25) params.set("perPage", String(query.perPage));
    if (page > 1) params.set("page", String(page));
    const text = params.toString();
    return text ? `/dbviewer?${text}` : "/dbviewer";
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

function imageLinks(value) {
    let images = value;
    if (typeof images === "string") {
        try {
            images = JSON.parse(images);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(images)) return [];

    const links = [];
    for (const image of images) {
        const url = safeLink(typeof image === "string" ? image : image?.url);
        if (url) links.push(url);
    }
    return links;
}

function formatPublished(value) {
    if (!value) return "—";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return `${date.toISOString().replace("T", " ").slice(0, 19)}Z`;
}

async function listSources(pool) {
    const result = await pool.query(`
        SELECT DISTINCT source
        FROM entries
        WHERE source IS NOT NULL
        ORDER BY source ASC
    `);
    return result.rows.map((row) => row.source);
}

async function searchEntries(pool, query) {
    const parsed = parseDbViewerQuery(query);
    const { where, params } = buildFilters(parsed);
    const count = await pool.query(
        `SELECT COUNT(*)::int AS total FROM entries WHERE ${where}`,
        params
    );
    const total = count.rows[0].total;
    const pageCount = Math.max(1, Math.ceil(total / parsed.perPage));
    const page = Math.min(parsed.page, pageCount);
    const rows = await pool.query(`
        SELECT id, title, content, source, publication_date, link,
               location_name, location_country, has_location, images, item_xml
        FROM entries
        WHERE ${where}
        ORDER BY ${SORTS[parsed.sort]}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, parsed.perPage, (page - 1) * parsed.perPage]);

    return {
        ...parsed,
        page,
        total,
        pageCount,
        prevHref: viewerHref(parsed, page - 1),
        nextHref: viewerHref(parsed, page + 1),
        rows: rows.rows.map((row) => ({
            id: String(row.id),
            published: formatPublished(row.publication_date),
            source: row.source || "—",
            title: row.title || "—",
            content: row.content || "",
            location: [row.location_name, row.location_country].filter(Boolean).join(" — ") || "—",
            hasLocation: Boolean(row.has_location),
            link: safeLink(row.link),
            images: imageLinks(row.images),
            itemXml: row.item_xml || ""
        }))
    };
}

function createDbViewerRouter(pool) {
    const router = express.Router();

    router.get("/dbviewer", async (req, res) => {
        const query = parseDbViewerQuery(req.query);
        const empty = {
            currentPage: "dbviewer",
            unavailable: null,
            sources: [],
            rows: [],
            total: 0,
            pageCount: 1,
            prevHref: "/dbviewer",
            nextHref: "/dbviewer",
            pageSizes: [10, 25, 50, 100],
            ...query
        };

        if (!pool) {
            return res.render("dbviewer.njk", {
                ...empty,
                unavailable: "PostgreSQL is not configured. Set DATABASE_URL to browse the database."
            });
        }

        try {
            const [sources, result] = await Promise.all([
                listSources(pool),
                searchEntries(pool, query)
            ]);
            if (query.source && !sources.includes(query.source)) sources.push(query.source);
            return res.render("dbviewer.njk", {
                ...empty,
                sources,
                ...result
            });
        } catch (error) {
            console.error("Database viewer query failed:", error.message);
            const missingTable = error.code === "42P01";
            return res.status(503).render("dbviewer.njk", {
                ...empty,
                unavailable: missingTable
                    ? "The entries table does not exist yet. It is created when the RSS worker connects."
                    : "The database could not be read."
            });
        }
    });

    return router;
}

module.exports = {
    SORTS,
    parseDateOnly,
    parseDbViewerQuery,
    buildFilters,
    viewerHref,
    imageLinks,
    formatPublished,
    listSources,
    searchEntries,
    createDbViewerRouter
};
