# Cronjob

## What is it

Cronjob lets you schedule AI tasks to run automatically on a recurring basis. You can set up periodic chat prompts or workflow executions that run without manual intervention.

## How it works

A background scheduler checks for due jobs every 10 seconds. When a job's next run time is reached, it fires off the execution asynchronously. Each execution creates a chat history entry so you can review what the AI said. The system prevents duplicate concurrent executions of the same job.

## Task Types

### Chat Task

Sends a prompt to an AI model on schedule. You configure the provider, model, and prompt. The AI response is saved and viewable in the execution history.

### Canvas Workflow Task

Executes a predefined canvas workflow on schedule. The system starts the workflow, monitors it for up to 30 minutes, and records the outputs of all nodes.

## Schedule Types

### Daily

Run at a specific time on selected days of the week. For example, every weekday at 9:00 AM.

### Interval

Run every N minutes. For example, every 30 minutes.

## Usage

1. Go to the **Cronjob** page from the sidebar.
2. Click **New** to create a job.
3. Configure:
   - **Name** — a descriptive label.
   - **Task Type** — Chat or Canvas Workflow.
   - **Provider & Model** — which AI to use (for chat tasks).
   - **Prompt** — what to ask the AI (for chat tasks).
   - **Workflow** — which workflow to run (for workflow tasks).
   - **Schedule** — daily with time/day selection, or interval in minutes.
   - **Enabled** — toggle the job on/off.
4. Click **Save**.

### Monitoring

- The job list shows each job's next run time and last run status.
- Click a job to view its execution history with timestamps, status, and duration.
- Click "Open Chat" on any execution to see the full AI conversation.

### Manual Execution

Click the **Run** button on any job to execute it immediately, regardless of its schedule.
