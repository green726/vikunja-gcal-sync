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
const { VIKUNJA_API_URL, VIKUNJA_API_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, CALENDAR_PREFIX, GOOGLE_CALENDAR_SHARE_WITH_EMAIL } = process.env;

// --- Configuration & Validation ---
if (!VIKUNJA_API_TOKEN || !GOOGLE_APPLICATION_CREDENTIALS || !GOOGLE_CALENDAR_SHARE_WITH_EMAIL) {
    console.error("FATAL: One or more required variables are not set in the .env file. Please check VIKUNJA_API_TOKEN, GOOGLE_APPLICATION_CREDENTIALS, and GOOGLE_CALENDAR_SHARE_WITH_EMAIL.");
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
const defaultData = { mappings: [] };
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
                timeZone: 'UTC'
            }
        });
        return response.data;
    } catch (error) {
        console.error(`Error creating calendar for project "${projectName}":`, error.message);
        return null;
    }
}

async function ensureCalendarIsShared(calendarId, calendarSummary) {
    try {
        const rules = await calendar.acl.list({ calendarId });
        const isAlreadyShared = rules.data.items.some(rule => rule.scope.value === GOOGLE_CALENDAR_SHARE_WITH_EMAIL);

        if (!isAlreadyShared) {
            console.log(`Sharing calendar "${calendarSummary}" with ${GOOGLE_CALENDAR_SHARE_WITH_EMAIL}...`);
            await calendar.acl.insert({
                calendarId: calendarId,
                requestBody: {
                    role: 'owner',
                    scope: {
                        type: 'user',
                        value: GOOGLE_CALENDAR_SHARE_WITH_EMAIL,
                    },
                },
            });
        }
    } catch (error) {
        console.error(`Failed to share calendar "${calendarSummary}":`, error.message);
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
        start: { date: dayjs(task.due_date).format('YYYY-MM-DD') },
        end: { date: dayjs(task.due_date).add(1, 'day').format('YYYY-MM-DD') },
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
    await db.read();

    const vikunjaProjects = await getVikunjaProjects();
    const vikunjaTasks = await getVikunjaTasks();
    let googleCalendars = await getManagedCalendars();
    
    // NEW: Filter for only uncompleted tasks for the sync logic.
    const uncompletedVikunjaTasks = vikunjaTasks.filter(task => !task.done);

    console.log(`Found ${vikunjaProjects.length} projects and ${vikunjaTasks.length} total tasks with due dates.`);
    console.log(`Syncing ${uncompletedVikunjaTasks.length} uncompleted tasks.`);
    console.log(`Found ${googleCalendars.length} managed calendars in Google.`);

    const projectMap = new Map(vikunjaProjects.map(p => [p.id, p]));

    // --- Step 2: Reconcile Calendars ---
    for (const project of vikunjaProjects) {
        const expectedCalName = `${CALENDAR_PREFIX} ${project.title}`;
        let gCal = googleCalendars.find(cal => cal.summary === expectedCalName);

        if (!gCal) {
            console.log(`DEBUG: No Google Calendar found for project "${project.title}". Attempting to create...`);
            const newCal = await createGoogleCalendar(project.title);
            if (newCal) {
                googleCalendars.push(newCal);
            }
        }
    }
    
    console.log("--- Verifying Calendar Permissions ---");
    for (const cal of googleCalendars) {
        await ensureCalendarIsShared(cal.id, cal.summary);
    }

    // --- Step 3: Reconcile Events ---
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

    // Use the uncompleted tasks list for the map.
    const vikunjaTaskMap = new Map(uncompletedVikunjaTasks.map(task => [String(task.id), task]));

    // Iterate over only the uncompleted tasks to create/update events.
    for (const task of uncompletedVikunjaTasks) {
        const taskIdStr = String(task.id);
        const existingGEvent = allGoogleEvents.get(taskIdStr);
        
        const project = projectMap.get(task.project_id);
        if (!project) {
            console.log(`Skipping task "${task.title}" (ID: ${task.id}) because its project (ID: ${task.project_id}) could not be found.`);
            continue;
        }
        
        const projectCalName = `${CALENDAR_PREFIX} ${project.title}`;
        const targetGCal = googleCalendars.find(cal => cal.summary === projectCalName);

        if (!targetGCal) {
            console.log(`Skipping task ${task.id} because its project calendar "${projectCalName}" was not found or created.`);
            continue;
        }

        const eventPayload = buildGoogleEvent(task);

        if (existingGEvent) {
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

    // --- Step 4: Clean up deleted OR COMPLETED tasks ---
    // This logic now implicitly handles completed tasks because they are absent from vikunjaTaskMap.
    for (const [vikunjaId, gEvent] of allGoogleEvents.entries()) {
        if (!vikunjaTaskMap.has(vikunjaId)) {
            console.log(`Deleting event for stale or completed task ID: ${vikunjaId}`);
            try {
                await calendar.events.delete({
                    calendarId: gEvent.calendarId,
                    eventId: gEvent.id
                });
            } catch (error) {
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
