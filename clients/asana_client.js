import 'dotenv/config';

const ASANA_BASE_URL = 'https://app.asana.com/api/1.0';

export async function createAsanaReviewTask({ accountId, companyName, nextVersion, accountDirName, changelogEntry }) {

    const token      = process.env.ASANA_ACCESS_TOKEN;
    const projectGid = process.env.ASANA_PROJECT_GID;

    if (!token) {
        console.warn('⚠️  ASANA_ACCESS_TOKEN not set — skipping task creation');
        return null;
    }

    if (!projectGid) {
        console.warn('⚠️  ASANA_PROJECT_GID not set — skipping task creation');
        return null;
    }

    const changeList = changelogEntry.changes.length > 0
        ? changelogEntry.changes.map(c =>
            `• ${c.field}: ${JSON.stringify(c.old)} → ${JSON.stringify(c.new)}`
          ).join('\n')
        : '• No fields changed';

    const basePath = `outputs/accounts/${accountDirName}/${nextVersion}`;

    const taskDescription = `
Account ID: ${accountId}
Company: ${companyName}

Version: ${nextVersion} (after onboarding)

Generated Files:
  ${basePath}/memo.json
  ${basePath}/agentDraftSpec.json
  ${basePath}/onboarding_update.json
  ${basePath}/changes.json

Changes Detected (${changelogEntry.changes.length} field(s)):
${changeList}

Version From: ${changelogEntry.version_from}
Version To:   ${changelogEntry.version_to}
Generated At: ${changelogEntry.generated_at}

Next Step:
Review configuration and approve deployment.
`.trim();

    const taskName = `Approve Clara agent configuration – ${companyName} (${nextVersion})`;

    try {
        const response = await fetch(`${ASANA_BASE_URL}/tasks`, {
            method: 'POST',
            headers: {
                Authorization  : `Bearer ${token}`,
                'Content-Type' : 'application/json',
                Accept         : 'application/json',
            },
            body: JSON.stringify({
                data: {
                    name     : taskName,
                    notes    : taskDescription,
                    projects : [projectGid],
                },
            }),
        });

        const result = await response.json();

        if (!response.ok) {
            console.warn(`⚠️  Asana API error: ${JSON.stringify(result.errors ?? result)}`);
            return null;
        }

        return result.data;

    } catch (err) {
        console.warn(`⚠️  Asana request failed: ${err.message}`);
        return null;
    }
}