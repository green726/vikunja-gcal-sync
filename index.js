
// index.js

// 1. Import Dependencies
// ----------------------
const express = require('express');
const axios = require('axios');
const { default: ical } = require('ical-generator');
require('dotenv').config();

// 2. Load Configuration from Environment Variables
// ------------------------------------------------
const { VIKUNJA_API_URL, VIKUNJA_API_TOKEN, PORT } = process.env;

// Basic validation to ensure the user has set up their .env file.
if (!VIKUNJA_API_TOKEN) {
    console.error("ERROR: VIKUNJA_API_TOKEN is not set in the .env file.");
    console.error("Please add your API token from Vikunja Settings -> API Tokens.");
    process.exit(1);
}

// 3. Helper Functions to Fetch Data from Vikunja
// ----------------------------------------------

/**
 * Fetches all projects the user has access to.
 */
async function fetchAllProjects() {
    const fullUrl = `${VIKUNJA_API_URL}/projects`;
    try {
        console.log(`Fetching all projects from Vikunja at: ${fullUrl}`);
        const response = await axios.get(fullUrl, {
            headers: { Authorization: `Bearer ${VIKUNJA_API_TOKEN}` }
        });
        return response.data;
    } catch (error) {
        console.error("Error fetching all projects from Vikunja:", error.response ? error.response.data : error.message);
        return [];
    }
}

/**
 * Fetches all tasks from all projects the user has access to.
 */
async function fetchAllVikunjaTasks() {
    const fullUrl = `${VIKUNJA_API_URL}/tasks/all`;
    try {
        console.log(`Fetching all tasks from Vikunja at: ${fullUrl}`);
        const response = await axios.get(fullUrl, {
            headers: { Authorization: `Bearer ${VIKUNJA_API_TOKEN}` }
        });
        const tasksWithDueDate = response.data.filter(task => task.due_date);
        console.log(`Found ${tasksWithDueDate.length} total tasks with a due date.`);
        return tasksWithDueDate;
    } catch (error) {
        console.error("Error fetching all tasks from Vikunja:", error.response ? error.response.data : error.message);
        return [];
    }
}

/**
 * Fetches tasks for a single, specific project.
 * @param {string} projectId The ID of the Vikunja project.
 */
async function fetchProjectTasks(projectId) {
    const fullUrl = `${VIKUNJA_API_URL}/projects/${projectId}/tasks`;
    try {
        console.log(`Fetching tasks for project ${projectId} at: ${fullUrl}`);
        const response = await axios.get(fullUrl, {
            headers: { Authorization: `Bearer ${VIKUNJA_API_TOKEN}` }
        });
        const tasksWithDueDate = response.data.filter(task => task.due_date);
        console.log(`Found ${tasksWithDueDate.length} tasks with a due date for project ${projectId}.`);
        return tasksWithDueDate;
    } catch (error) {
        console.error(`Error fetching tasks for project ${projectId}:`, error.response ? error.response.data : error.message);
        return [];
    }
}


// 4. Create and Configure the Express Server
// ------------------------------------------
const app = express();

/**
 * Route for a combined calendar of all tasks from all projects.
 */
app.get('/ical/all', async (req, res) => {
    console.log("Received request for 'all tasks' iCal feed.");
    const calendar = ical({ name: 'All Vikunja Tasks' });
    const tasks = await fetchAllVikunjaTasks();

    tasks.forEach(task => {
        const taskUrl = `https://cloud.vikunja.io/projects/${task.project_id}/tasks/${task.id}`;
        calendar.createEvent({
            start: new Date(task.due_date),
            end: new Date(task.due_date),
            allDay: true,
            summary: `[${task.project.title}] ${task.title}`, // Add project name to summary
            description: `${task.description || ''}\n\nView in Vikunja: ${taskUrl}`,
            uid: `vikunja-task-${task.id}@vikunja.cloud`
        });
    });

    res.setHeader('Content-Type', 'text/calendar;charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="vikunja-all.ics"');
    res.send(calendar.toString());
    console.log("Successfully sent 'all tasks' iCal feed.");
});

/**
 * Dynamic route for project-specific iCal feeds using the project name.
 * Example: /ical/project/My%20Project%20Name
 */
app.get('/ical/project/:projectName', async (req, res) => {
    const { projectName } = req.params;
    console.log(`Received request for iCal feed for project name: "${projectName}"`);

    const allProjects = await fetchAllProjects();
    const project = allProjects.find(p => p.title.toLowerCase() === projectName.toLowerCase());

    if (!project) {
        return res.status(404).send(`Project with name "${projectName}" not found or you may not have access.`);
    }
    
    const projectId = project.id;
    const calendarName = `Vikunja - ${project.title}`;
    const calendar = ical({ name: calendarName });
    const tasks = await fetchProjectTasks(projectId);

    tasks.forEach(task => {
        const taskUrl = `https://cloud.vikunja.io/projects/${task.project_id}/tasks/${task.id}`;
        calendar.createEvent({
            start: new Date(task.due_date),
            end: new Date(task.due_date),
            allDay: true,
            summary: task.title,
            description: `${task.description || ''}\n\nView in Vikunja: ${taskUrl}`,
            uid: `vikunja-task-${task.id}@vikunja.cloud`
        });
    });

    res.setHeader('Content-Type', 'text/calendar;charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vikunja-project-${projectId}.ics"`);
    res.send(calendar.toString());
    console.log(`Successfully sent iCal feed for project ${projectId} ("${projectName}").`);
});


// 5. Start the Server and List Projects
// -------------------------------------
app.listen(PORT, async () => {
    console.log(`Vikunja iCal server is running on http://localhost:${PORT}`);
    console.log(`All tasks feed: http://localhost:${PORT}/ical/all`);
    console.log(`Project-specific feed example: http://localhost:${PORT}/ical/project/Your%20Project%20Name`);
    console.log("\nFetching available projects...");

    const projects = await fetchAllProjects();
    if (projects.length > 0) {
        console.log("--- Available Projects ---");
        projects.forEach(p => {
            // Encode the project title for use in a URL, replacing spaces with %20 etc.
            const encodedName = encodeURIComponent(p.title);
            console.log(`  Name: "${p.title}" (ID: ${p.id})`);
            console.log(`  URL : http://localhost:${PORT}/ical/project/${encodedName}\n`);
        });
        console.log("--------------------------");
    } else {
        console.log("Could not find any projects. Check your API token permissions.");
    }
});
