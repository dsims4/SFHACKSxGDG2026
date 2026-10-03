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
    CONSTRAINT article_summaries_five_bullets CHECK (jsonb_typeof(summary) = 'array')
);

ALTER TABLE article_summaries ADD COLUMN IF NOT EXISTS topic TEXT CHECK (topic ~ '^[a-z][a-z-]{0,49}$');
ALTER TABLE article_summaries ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE TABLE IF NOT EXISTS topic_summaries (
    id BIGSERIAL PRIMARY KEY,
    topic TEXT NOT NULL CHECK (topic ~ '^[a-z][a-z-]{0,49}$'),
    date DATE NOT NULL,
    summary JSONB NOT NULL CHECK (jsonb_typeof(summary) = 'array' AND jsonb_array_length(summary) = 5),
    source_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (topic, date)
);

CREATE TABLE IF NOT EXISTS topic_bullet_articles (
    topic_summary_id BIGINT NOT NULL REFERENCES topic_summaries(id) ON DELETE CASCADE,
    bullet INTEGER NOT NULL CHECK (bullet BETWEEN 1 AND 5),
    article_id BIGINT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    PRIMARY KEY (topic_summary_id, bullet, article_id)
);
CREATE INDEX IF NOT EXISTS idx_topic_summaries_date ON topic_summaries(date DESC);
CREATE INDEX IF NOT EXISTS idx_article_summaries_topic ON article_summaries(topic);

ALTER TABLE entries ADD COLUMN IF NOT EXISTS topics TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_entries_topics ON entries USING GIN(topics);
ALTER TABLE article_summaries ADD COLUMN IF NOT EXISTS classification_version INTEGER NOT NULL DEFAULT 1;
UPDATE entries e SET topics = ARRAY[s.topic] FROM article_summaries s
WHERE s.article_id = e.id AND s.topic IS NOT NULL AND cardinality(e.topics) = 0;

CREATE TABLE IF NOT EXISTS worker_schedule (
    name TEXT PRIMARY KEY,
    next_run_at TIMESTAMPTZ NOT NULL
);


-- Accept only populated string bullets, with zero to five facts per summary.
CREATE OR REPLACE FUNCTION valid_news_bullets(value JSONB) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE AS $$
    SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN
        jsonb_array_length(value) <= 5 AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(value) bullet
            WHERE jsonb_typeof(bullet) <> 'string' OR (bullet #>> '{}') !~ '[^[:space:]]'
        ) ELSE FALSE END;
$$;
ALTER TABLE article_summaries DROP CONSTRAINT IF EXISTS article_summaries_five_bullets;
ALTER TABLE article_summaries ADD CONSTRAINT article_summaries_five_bullets CHECK (valid_news_bullets(summary));
ALTER TABLE topic_summaries DROP CONSTRAINT IF EXISTS topic_summaries_summary_check;
ALTER TABLE topic_summaries ADD CONSTRAINT topic_summaries_summary_check CHECK (valid_news_bullets(summary));

ALTER TABLE topic_summaries ADD COLUMN IF NOT EXISTS source_window_days INTEGER NOT NULL DEFAULT 2;


-- Preserve today's topic navigation while replacing legacy mixed-day summaries.
DELETE FROM topic_bullet_articles b USING topic_summaries t
WHERE b.topic_summary_id = t.id AND t.source_window_days <> 1
    AND t.date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date;
UPDATE topic_summaries SET summary = '[]'::jsonb, source_hash = '', source_window_days = 1
WHERE source_window_days <> 1 AND date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date;
INSERT INTO topic_summaries(topic, date, summary, source_hash, model, source_window_days)
SELECT DISTINCT topic, (NOW() AT TIME ZONE 'America/Los_Angeles')::date, '[]'::jsonb, '', 'pending', 1
FROM entries e CROSS JOIN LATERAL unnest(e.topics) membership(topic)
WHERE e.publication_date >= (date_trunc('day', NOW() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'America/Los_Angeles')
    AND e.publication_date <= NOW()
ON CONFLICT(topic, date) DO NOTHING;
