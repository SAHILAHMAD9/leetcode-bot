require("dotenv").config();
const { Client } = require("@notionhq/client");
const axios = require("axios");

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID =process.env.NOTION_DATABASE_ID; 
const LEETCODE_API_URL = "https://leetcode.com/api/submissions/?offset=1&limit=50";
const LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql";
const LEETCODE_SESSION_COOKIE = process.env.LEETCODE_SESSION_COOKIE;
const CSRF_TOKEN_COOKIE = process.env.CSRF_TOKEN_COOKIE;
// console.log("1",NOTION_API_KEY);
// console.log("2",NOTION_DATABASE_ID);
// console.log("3", LEETCODE_SESSION_COOKIE);
// console.log("4", CSRF_TOKEN_COOKIE);
const notion = new Client({ auth: NOTION_API_KEY });

async function getExistingProblems() {
    const existingProblems = new Set();
    try {
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
        });
        response.results.forEach(page => {
            const title = page.properties['Problem Name']?.title[0]?.plain_text;
            if (title) {
                existingProblems.add(title);
            }
        });
    } catch (error) {
        console.error("Error fetching existing problems from Notion:", error.message);
    }
    return existingProblems;
}

async function getProblemDetails(titleSlug) {
    const query = `
    query questionData($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        difficulty
        topicTags {
          name
        }
      }
    }
  `;
    try {
        const response = await axios.post(
            LEETCODE_GRAPHQL_URL, {
            query,
            variables: { titleSlug },
        }, {
            headers: {
                Cookie: `LEETCODE_SESSION=${LEETCODE_SESSION_COOKIE}; csrftoken=${CSRF_TOKEN_COOKIE};`,
            },
        }
        );
        return response.data.data.question;
    } catch (error) {
        console.error(`Failed to fetch details for ${titleSlug}:`, error.message);
        return null;
    }
}
// this will fetch all my submitons and add it to my notion datbase (Promise is there to dodge the rate limit for api )
async function getRecentLeetCodeSubmissions() {
    console.log("Fetching all LeetCode submissions (this might take a while)...");

    let allSubmissions = [];
    let hasNext = true;
    let offset = 0;
    const limit = 20;

    while (hasNext) {
        try {
            const url = `https://leetcode.com/api/submissions/?offset=${offset}&limit=${limit}`;
            console.log(`Fetching submissions from offset ${offset}...`);

            const response = await axios.get(url, {
                headers: {
                    Cookie: `LEETCODE_SESSION=${LEETCODE_SESSION_COOKIE}; csrftoken=${CSRF_TOKEN_COOKIE};`,
                },
            });

            const fetchedSubmissions = response.data.submissions_dump;
            if (fetchedSubmissions && fetchedSubmissions.length > 0) {
                allSubmissions.push(...fetchedSubmissions);
            }

            // Check if there's a next page
            hasNext = response.data.has_next;
            offset += limit;
            if (hasNext) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
            }

        } catch (error) {
            console.error("Failed to fetch a page of submissions from LeetCode:", error.message);
            hasNext = false;
        }
    }
    // Filter for only accepted submissions that have code
    const acceptedSubmissions = allSubmissions.filter(
        (sub) => sub.status_display === "Accepted" && sub.code
    );

    return acceptedSubmissions;
}
async function addSubmissionToNotion(submission, details) {
    const problemUrl = `https://leetcode.com/problems/${submission.title_slug}/`;

    console.log(`Adding '${submission.title}' to Notion...`);

    try {
        await notion.pages.create({
            parent: { database_id: NOTION_DATABASE_ID },
            properties: {
                'Problem Name': {
                    title: [{ text: { content: submission.title } }],
                },
                'URL': { url: problemUrl },
                'Date': {
                    date: { start: new Date(submission.timestamp * 1000).toISOString() },
                },
                'Difficulty': {
                    select: { name: details.difficulty },
                },
                'Tags': {
                    multi_select: details.topicTags.map(tag => ({ name: tag.name })),
                },
                'Solution Code': {
                    rich_text: [
                        {
                            type: 'text',
                            text: {
                                content: submission.code
                            }
                        }
                    ]
                }
            },
        });
        console.log(`✅ Successfully added '${submission.title}'!`);
    } catch (error) {
        console.error(`❌ Error adding '${submission.title}' to Notion:`, error.message);
    }
}

async function main() {
    const existingProblems = await getExistingProblems();
    const submissions = await getRecentLeetCodeSubmissions();

    if (submissions.length === 0) {
        console.log("No new accepted submissions found.");
        return;
    }
    const uniqueSubmissions = new Map();
    submissions.forEach(sub => {
        if (!uniqueSubmissions.has(sub.title)) {
            uniqueSubmissions.set(sub.title, sub);
        }
    });

    console.log(`Found ${uniqueSubmissions.size} unique problems to process.`);

    for (const submission of uniqueSubmissions.values()) {
        if (existingProblems.has(submission.title)) {
            console.log(`-- Skipping '${submission.title}', already exists.`);
            continue; 
        }

        const details = await getProblemDetails(submission.title_slug);
        if (details) {
            await addSubmissionToNotion(submission, details);
            // Add a small delay to avoid hitting API rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    console.log("Bye bye ctrl+c ctrl+v !");
}

main();