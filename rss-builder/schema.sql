CREATE TABLE IF NOT EXISTS entries (
    id BIGSERIAL PRIMARY KEY,
    title TEXT,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    publication_date TIMESTAMPTZ NOT NULL,
    link TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (source, link)
);

ALTER TABLE entries ADD COLUMN IF NOT EXISTS location_name TEXT;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS location_level TEXT;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS location_country TEXT;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS country_lat DOUBLE PRECISION;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS country_lng DOUBLE PRECISION;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS has_location BOOLEAN DEFAULT FALSE;

ALTER TABLE entries ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]';

ALTER TABLE entries ADD COLUMN IF NOT EXISTS item_xml TEXT;

CREATE INDEX IF NOT EXISTS idx_entries_publication_date ON entries (publication_date DESC);

CREATE INDEX IF NOT EXISTS idx_entries_source ON entries (source);

CREATE TABLE IF NOT EXISTS article_summaries (
    id BIGSERIAL PRIMARY KEY,
    article_id BIGINT NOT NULL UNIQUE REFERENCES entries (id) ON DELETE CASCADE,
    summary JSONB NOT NULL,
    model TEXT NOT NULL CHECK (BTRIM(model) <> ''),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT article_summaries_five_bullets CHECK (
        CASE WHEN jsonb_typeof(summary) = 'array' THEN
            jsonb_array_length(summary) = 5
            AND jsonb_typeof(summary -> 0) = 'string'
            AND jsonb_typeof(summary -> 1) = 'string'
            AND jsonb_typeof(summary -> 2) = 'string'
            AND jsonb_typeof(summary -> 3) = 'string'
            AND jsonb_typeof(summary -> 4) = 'string'
            AND (summary ->> 0) ~ '[^[:space:]]'
            AND (summary ->> 1) ~ '[^[:space:]]'
            AND (summary ->> 2) ~ '[^[:space:]]'
            AND (summary ->> 3) ~ '[^[:space:]]'
            AND (summary ->> 4) ~ '[^[:space:]]'
        ELSE FALSE END
    )
);
