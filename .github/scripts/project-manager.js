const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

async function moveToColumn(issueNumber, columnName) {
  try {
    // Get project ID
    const project = await octokit.projects.getProject({
      project_id: process.env.PROJECT_ID
    });

    // Get column ID
    const columns = await octokit.projects.listColumns({
      project_id: project.data.id
    });

    const targetColumn = columns.data.find(col => col.name === columnName);
    if (!targetColumn) {
      throw new Error(`Column ${columnName} not found`);
    }

    // Add card to column
    await octokit.projects.createCard({
      column_id: targetColumn.id,
      content_id: issueNumber,
      content_type: 'Issue'
    });

    console.log(`Moved issue #${issueNumber} to ${columnName}`);
  } catch (error) {
    console.error('Error moving card:', error);
  }
}

// Export functions for use in workflows
module.exports = {
  moveToColumn
}; 