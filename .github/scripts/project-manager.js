const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

async function moveToColumn(issueNumber, action) {
  console.log(`Moving issue/PR #${issueNumber} based on action: ${action}`);
  
  try {
    const projectId = process.env.PROJECT_ID;
    if (!projectId) {
      throw new Error('PROJECT_ID environment variable is not set');
    }

    console.log(`Getting project with ID: ${projectId}`);
    
    // Get project columns
    const { data: columns } = await octokit.projects.listColumns({
      project_id: parseInt(projectId, 10)
    });

    console.log('Available columns:', columns.map(c => c.name));

    // Determine target column based on action
    let targetColumn;
    switch (action) {
      case 'opened':
        targetColumn = columns.find(col => col.name.toLowerCase() === 'to do');
        break;
      case 'review_requested':
        targetColumn = columns.find(col => col.name.toLowerCase() === 'review');
        break;
      case 'closed':
      case 'merged':
        targetColumn = columns.find(col => col.name.toLowerCase() === 'done');
        break;
      default:
        targetColumn = columns.find(col => col.name.toLowerCase() === 'in progress');
    }

    if (!targetColumn) {
      throw new Error(`No matching column found for action: ${action}`);
    }

    console.log(`Creating card in column: ${targetColumn.name}`);

    // Create card in column
    await octokit.projects.createCard({
      column_id: targetColumn.id,
      content_id: parseInt(issueNumber, 10),
      content_type: 'Issue'
    });

    console.log('Card created successfully');
  } catch (error) {
    console.error('Error in moveToColumn:', error);
    process.exit(1);
  }
}

// Get command line arguments
const issueNumber = process.argv[2];
const action = process.argv[3];

console.log('Starting project manager with args:', { issueNumber, action });

if (!issueNumber || !action) {
  console.error('Missing required arguments: issueNumber and action');
  process.exit(1);
}

moveToColumn(issueNumber, action);

// Export functions for use in workflows
module.exports = {
  moveToColumn
}; 