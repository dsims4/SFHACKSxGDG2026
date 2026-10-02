const express = require("express");

const router = express.Router();


// -------------------------
// TEMPORARY DATA           =============================================================
// -------------------------

const topics = [
    {
        id: 1,
        title: "Topic 1",
        generalSummary: "This is a generated general summary combining the main information from all stories currently grouped under Topic 1.",
        stories: [
            {
                id: 1,
                title: "Story 1 Title",
                summary: "Generated non-biased summary here.",
                sources: [
                    {
                        name: "Source 1",
                        url: "https://example.com"
                    },
                    {
                        name: "Source 2",
                        url: "https://example.com"
                    }
                ]
            },
            {
                id: 2,
                title: "Story 2 Title",
                summary: "Generated non-biased summary here.",
                sources: [
                    {
                        name: "Source 1",
                        url: "https://example.com"
                    }
                ]
            },
            {
                id: 3,
                title: "Story 3 Title",
                summary: "Generated non-biased summary here.",
                sources: []
            },
            {
                id: 4,
                title: "Story 4 Title",
                summary: "Generated non-biased summary here.",
                sources: []
            },
            {
                id: 5,
                title: "Story 5 Title",
                summary: "Generated non-biased summary here.",
                sources: []
            }
        ]
    },

    {
        id: 2,
        title: "Topic 2",
        generalSummary: "This is a generated general summary combining the main information from all stories currently grouped under Topic 2.",
        stories: [
            {
                id: 6,
                title: "Story 6 Title",
                summary: "Generated non-biased summary here.",
                sources: []
            },
            {
                id: 7,
                title: "Story 7 Title",
                summary: "Generated non-biased summary here.",
                sources: []
            }
        ]
    }
];

// ==========================================================================================



// -------------------------
// HOMEPAGE
// -------------------------

router.get("/", (req, res) => {
    return res.render("index.njk", {
        currentPage: "index",
        topics: topics
    });
});


// -------------------------
// TOPIC PAGE
// -------------------------

router.get("/topic/:id", (req, res) => {
    const topicId = Number(req.params.id);

    const topic = topics.find(topic => topic.id === topicId);

    return res.render("topic.njk", {
        currentPage: "topic",
        topic: topic
    });
});


// -------------------------
// STORY PAGE
// -------------------------

router.get("/story/:id", (req, res) => {
    const storyId = Number(req.params.id);

    let story;

    for (const topic of topics) {
        story = topic.stories.find(story => story.id === storyId);

        if (story) {
            break;
        }
    }

    return res.render("story.njk", {
        currentPage: "story",
        story: story
    });
});


module.exports = router;