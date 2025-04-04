const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

async function moveToColumn(issueNumber, action) {
  try {
    // Get project ID
    const project = await octokit.projects.getProject({
      project_id: process.env.PROJECT_ID
    });

    // Get column ID
    const columns = await octokit.projects.listColumns({
      project_id: project.data.id
    });

    // Determine target column based on action
    let targetColumn;
    switch (action) {
      case 'opened':
        targetColumn = columns.data.find(col => col.name === 'To Do');
        break;
      case 'review_requested':
        targetColumn = columns.data.find(col => col.name === 'Review');
        break;
      case 'closed':
      case 'merged':
        targetColumn = columns.data.find(col => col.name === 'Done');
        break;
      default:
        targetColumn = columns.data.find(col => col.name === 'In Progress');
    }

    if (!targetColumn) {
      throw new Error(`Column not found for action: ${action}`);
    }

    // Add card to column
    await octokit.projects.createCard({
      column_id: targetColumn.id,
      content_id: issueNumber,
      content_type: 'Issue'
    });

    console.log(`Moved issue #${issueNumber} to ${targetColumn.name}`);
  } catch (error) {
    console.error('Error moving card:', error);
  }
}

// Get command line arguments
const issueNumber = process.argv[2];
const action = process.argv[3];

if (issueNumber && action) {
  moveToColumn(issueNumber, action);
} else {
  console.error('Missing required arguments: issueNumber and action');
  process.exit(1);
}

// Export functions for use in workflows
module.exports = {
  moveToColumn
}; 