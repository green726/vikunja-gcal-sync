// sync.js

// 1. --- SETUP AND INITIALIZATION ---
// ------------------------------------
console.log(`Vikunja-Google Sync started at: ${new Date().toISOString()}`);

const { google } = require('googleapis');
const axios = require('axios');
const path = require('path');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

// For the simple file-based database
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

require('dotenv').config();

// Load environment variables
const { VIKUNJA_API_URL, VIKUNJA_API_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, CALENDAR_PREFIX } = process.env;

// --- Configuration & Validation ---
if (!VIKUNJA_API_TOKEN || !GOOGLE_APPLICATION_CREDENTIALS) {
    console.error("FATAL: VIKUNJA_API_TOKEN or GOOGLE_APPLICATION_CREDENTIALS is not set in the .env file.");
    process.exit(1);
}

// --- Initialize Google API Client ---
const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/calendar'],
});
const calendar = google.calendar({ version: 'v3', auth });

// --- Initialize Database ---
const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const defaultData = { mappings: [] }; // Mappings will store { vikunjaTaskId, googleCalendarId, googleEventId }
const db = new Low(adapter, defaultData);


// 2. --- HELPER FUNCTIONS ---
// ---------------------------

// --- Vikunja Functions ---
async function getVikunjaProjects() {
    try {
        const response = await axios.get(`${VIKUNJA_API_URL}/projects`, {
            headers: { Authorization: `Bearer ${VIKUNJA_API_TOKEN}` }
        });
        return response.data;
    } catch (error) {
        console.error("Error fetching Vikunja projects:", error.message);
        return [];
    }
}

async function getVikunjaTasks() {
    try {
        const response = await axios.get(`${VIKUNJA_API_URL}/tasks/all`, {
            headers: { Authorization: `Bearer ${VIKUNJA_API_TOKEN}` }
        });
        // Filter for tasks with due dates, as others can't be synced.
        return response.data.filter(task => task.due_date);
    } catch (error) {
        console.error("Error fetching Vikunja tasks:", error.message);
        return [];
    }
}

// --- Google Calendar Functions ---
async function getManagedCalendars() {
    try {
        const response = await calendar.calendarList.list();
        // Filter for calendars created by this script.
        return response.data.items.filter(cal => cal.summary.startsWith(CALENDAR_PREFIX));
    } catch (error) {
        console.error("Error fetching Google Calendars:", error.message);
        return [];
    }
}

async function createGoogleCalendar(projectName) {
    const calendarName = `${CALENDAR_PREFIX} ${projectName}`;
    console.log(`Creating new Google Calendar: "${calendarName}"`);
    try {
        const response = await calendar.calendars.insert({
            requestBody: {
                summary: calendarName,
                timeZone: 'UTC' // Use UTC for consistency
            }
        });
        return response.data;
    } catch (error) {
        console.error(`Error creating calendar for project "${projectName}":`, error.message);
        return null;
    }
}

async function getGoogleEvents(calendarId) {
    try {
        const response = await calendar.events.list({ calendarId });
        return response.data.items;
    } catch (error) {
        console.error(`Error fetching events for calendar ${calendarId}:`, error.message);
        return [];
    }
}

function buildGoogleEvent(task) {
    return {
        summary: task.title,
        description: `${task.description || ''}\n\nView in Vikunja: https://cloud.vikunja.io/projects/${task.project_id}/tasks/${task.id}`,
        // For all-day events, date is used instead of dateTime.
        start: { date: dayjs(task.due_date).format('YYYY-MM-DD') },
        end: { date: dayjs(task.due_date).add(1, 'day').format('YYYY-MM-DD') },
        // Store Vikunja task ID for easy lookup.
        extendedProperties: {
            private: {
                vikunjaTaskId: String(task.id)
            }
        }
    };
}


// 3. --- CORE SYNC LOGIC ---
// --------------------------
async function runSync() {
    console.log("--- Starting Sync Cycle ---");
    await db.read(); // Load the database from file

    // --- Step 1: Fetch current state from both services ---
    const vikunjaProjects = await getVikunjaProjects();
    const vikunjaTasks = await getVikunjaTasks();
    const googleCalendars = await getManagedCalendars();
    console.log(`Found ${vikunjaProjects.length} projects and ${vikunjaTasks.length} tasks in Vikunja.`);
    console.log(`Found ${googleCalendars.length} managed calendars in Google.`);

    // --- Step 2: Reconcile Calendars ---
    // Ensure every Vikunja project has a corresponding Google Calendar.
    for (const project of vikunjaProjects) {
        const expectedCalName = `${CALENDAR_PREFIX} ${project.title}`;
        let gCal = googleCalendars.find(cal => cal.summary === expectedCalName);

        if (!gCal) {
            const newCal = await createGoogleCalendar(project.title);
            if (newCal) {
                googleCalendars.push(newCal); // Add to our in-memory list
            }
        }
    }

    // --- Step 3: Reconcile Events (The main work) ---
    const allGoogleEvents = new Map();
    for (const cal of googleCalendars) {
        const events = await getGoogleEvents(cal.id);
        events.forEach(event => {
            const vikunjaId = event.extendedProperties?.private?.vikunjaTaskId;
            if (vikunjaId) {
                allGoogleEvents.set(vikunjaId, { ...event, calendarId: cal.id });
            }
        });
    }

    // Create a map of Vikunja tasks for quick lookups
    const vikunjaTaskMap = new Map(vikunjaTasks.map(task => [String(task.id), task]));

    // --- Go through each Vikunja task and decide what to do ---
    for (const task of vikunjaTasks) {
        const taskIdStr = String(task.id);
        const existingGEvent = allGoogleEvents.get(taskIdStr);
        const projectCalName = `${CALENDAR_PREFIX} ${task.project.title}`;
        const targetGCal = googleCalendars.find(cal => cal.summary === projectCalName);

        if (!targetGCal) {
            console.log(`Skipping task ${task.id} because its project calendar "${projectCalName}" was not found or created.`);
            continue;
        }

        const eventPayload = buildGoogleEvent(task);

        if (existingGEvent) {
            // Task exists in Google Calendar, check if it needs an update.
            const taskUpdated = dayjs.utc(task.updated_at);
            const eventUpdated = dayjs.utc(existingGEvent.updated);

            if (taskUpdated.isAfter(eventUpdated)) {
                console.log(`Updating event for task: "${task.title}" (ID: ${task.id})`);
                try {
                    await calendar.events.update({
                        calendarId: existingGEvent.calendarId,
                        eventId: existingGEvent.id,
                        requestBody: eventPayload
                    });
                } catch (error) {
                    console.error(`Failed to update event for task ${task.id}:`, error.message);
                }
            }
        } else {
            // Task does not exist in Google Calendar, create it.
            console.log(`Creating new event for task: "${task.title}" (ID: ${task.id})`);
            try {
                await calendar.events.insert({
                    calendarId: targetGCal.id,
                    requestBody: eventPayload
                });
            } catch (error) {
                console.error(`Failed to create event for task ${task.id}:`, error.message);
            }
        }
    }

    // --- Step 4: Clean up deleted tasks ---
    // Go through events in Google and see if the corresponding task still exists in Vikunja.
    for (const [vikunjaId, gEvent] of allGoogleEvents.entries()) {
        if (!vikunjaTaskMap.has(vikunjaId)) {
            console.log(`Deleting event for stale task ID: ${vikunjaId}`);
            try {
                await calendar.events.delete({
                    calendarId: gEvent.calendarId,
                    eventId: gEvent.id
                });
            } catch (error) {
                // Ignore "410 Gone" errors, which happen if the event was already deleted.
                if (error.code !== 410) {
                    console.error(`Failed to delete event ${gEvent.id}:`, error.message);
                }
            }
        }
    }

    console.log("--- Sync Cycle Finished ---");
}

// --- Run the main function ---
runSync().catch(console.error);
