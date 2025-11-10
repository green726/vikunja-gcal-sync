// sync.js

// 1. --- SETUP AND INITIALIZATION ---
// ------------------------------------
console.log(`Vikunja-Google Sync started at: ${new Date().toISOString()}`);

// These are CommonJS modules, safe to require at the top level.
const axios = require('axios');
const path = require('path');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

require('dotenv').config();

// We wrap the entire application in an async function to allow for dynamic imports of ES Modules.
async function run() {
    // Dynamically import ES Modules like 'node-fetch' and 'lowdb'.
    const { Headers, Blob, FormData } = await import('node-fetch');
    const { Low } = await import('lowdb');
    const { JSONFile } = await import('lowdb/node');

    // Polyfill global browser-like objects before requiring googleapis.
    global.Headers = Headers;
    global.Blob = Blob;
    global.FormData = FormData;
    
    // Now that the polyfills are in place, we can require googleapis.
    const { google } = require('googleapis');

    // Load environment variables
    const { VIKUNJA_API_URL, VIKUNJA_API_TOKEN, VIKUNJA_FRONTEND_URL, GOOGLE_APPLICATION_CREDENTIALS, CALENDAR_PREFIX, GOOGLE_CALENDAR_SHARE_WITH_EMAIL } = process.env;

    // --- Configuration & Validation ---
    if (!VIKUNJA_API_TOKEN || !GOOGLE_APPLICATION_CREDENTIALS || !GOOGLE_CALENDAR_SHARE_WITH_EMAIL || !VIKUNJA_FRONTEND_URL) {
        console.error("FATAL: One or more required variables are not set in the .env file. Please check all required variables.");
        process.exit(1);
    }
    
    // --- Initialize Google API Client ---
    const auth = new google.auth.GoogleAuth({
        keyFile: GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    // --- Helper function for API call delay ---
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));


    // 2. --- HELPER FUNCTIONS ---
    // ----------------------------------------------------------------

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
        let allTasks = [];
        let page = 1;
        let hasMorePages = true;

        while (hasMorePages) {
            console.log(`Fetching tasks page ${page}...`);
            const response = await axios.get(`${VIKUNJA_API_URL}/tasks/all`, {
                headers: { Authorization: `Bearer ${VIKUNJA_API_TOKEN}` },
                params: { page: page }
            });

            const tasks = response.data;
            allTasks = allTasks.concat(tasks);

            // Check pagination headers to see if there are more pages
            const totalPages = parseInt(response.headers['x-pagination-total-pages'] || '1');
            const resultCount = parseInt(response.headers['x-pagination-result-count'] || '0');
            
            console.log(`  Got ${resultCount} tasks. Page ${page} of ${totalPages}`);
            
            hasMorePages = page < totalPages;
            page++;
        }

        console.log(`Total tasks fetched: ${allTasks.length}`);
        return allTasks.filter(task => task.due_date);
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
        // Use the new VIKUNJA_FRONTEND_URL from the .env file
        const viewLink = `${VIKUNJA_FRONTEND_URL}/projects/${task.project_id}/tasks/${task.id}`;
        return {
            summary: task.title,
            description: `${task.description || ''}\n\nView in Vikunja: ${viewLink}`,
            start: { date: dayjs(task.due_date).format('YYYY-MM-DD') },
            end: { date: dayjs(task.due_date).add(1, 'day').format('YYYY-MM-DD') },
            transparency: 'opaque',
            extendedProperties: {
                private: {
                    vikunjaTaskId: String(task.id)
                }
            }
        };
    }


    // 3. --- CORE SYNC LOGIC ---
    // -----------------------------------------------------------
    console.log("--- Starting Sync Cycle ---");
    
    const vikunjaProjects = await getVikunjaProjects();
    const vikunjaTasks = await getVikunjaTasks();

	for (const task of vikunjaTasks) {
	   console.log(`${task.title}`);
	}


    let googleCalendars = await getManagedCalendars();
    
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
            const newCal = await createGoogleCalendar(project.title);
            if (newCal) {
                googleCalendars.push(newCal);
                await delay(200);
            }
        }
    }
    
    // --- Verifying Calendar Permissions ---
    for (const cal of googleCalendars) {
        await ensureCalendarIsShared(cal.id, cal.summary);
        await delay(200);
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
        await delay(200);
    }

    const vikunjaTaskMap = new Map(uncompletedVikunjaTasks.map(task => [String(task.id), task]));

    for (const task of uncompletedVikunjaTasks) {
        const taskIdStr = String(task.id);
        let existingGEvent = allGoogleEvents.get(taskIdStr);
        
        const project = task.project ? task.project : projectMap.get(task.project_id);
        
        if (!project) {
            console.log(`Skipping task "${task.title}" (ID: ${task.id}) because its project could not be determined.`);
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
            const needsMove = existingGEvent.calendarId !== targetGCal.id;
            const taskUpdated = dayjs.utc(task.updated_at);
            const eventUpdated = dayjs.utc(existingGEvent.updated);

            if (needsMove || taskUpdated.isAfter(eventUpdated) || existingGEvent.transparency !== 'opaque') {
                if (needsMove) {
                    console.log(`Moving task "${task.title}" from an old calendar.`);
                    try {
                        await calendar.events.delete({ calendarId: existingGEvent.calendarId, eventId: existingGEvent.id });
                        await delay(200);
                    } catch (error) {
                         if (error.code !== 410) console.error(`Failed to delete old event during move for task ${task.id}:`, error.message);
                    }
                    existingGEvent = null; 
                } else {
                    console.log(`Updating event for task: "${task.title}" (ID: ${task.id})`);
                    try {
                        await calendar.events.update({
                            calendarId: existingGEvent.calendarId,
                            eventId: existingGEvent.id,
                            requestBody: eventPayload
                        });
                        await delay(200);
                    } catch (error) {
                        console.error(`Failed to update event for task ${task.id}:`, error.message);
                    }
                }
            }
        }
        
        if (!existingGEvent) {
            console.log(`Creating new event for task: "${task.title}" (ID: ${task.id})`);
            try {
                await calendar.events.insert({
                    calendarId: targetGCal.id,
                    requestBody: eventPayload
                });
                await delay(200);
            } catch (error) {
                console.error(`Failed to create event for task ${task.id}:`, error.message);
            }
        }
    }

    // --- Step 4: Clean up deleted OR COMPLETED tasks ---
    for (const [vikunjaId, gEvent] of allGoogleEvents.entries()) {
        if (!vikunjaTaskMap.has(vikunjaId)) {
            console.log(`Deleting event for stale or completed task ID: ${vikunjaId}`);
            try {
                await calendar.events.delete({
                    calendarId: gEvent.calendarId,
                    eventId: gEvent.id
                });
                await delay(200);
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
run().catch(console.error);
