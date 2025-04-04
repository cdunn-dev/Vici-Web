# Vici

Vici is a modern web application designed to provide personalized training plans and fitness tracking capabilities. This repository contains the frontend implementation of the Vici application.

## Features

- **Personalized Training Plans**: AI-powered workout recommendations based on user goals and preferences
- **Progress Tracking**: Comprehensive metrics and analytics for tracking fitness progress
- **User Management**: Secure authentication and profile management
- **Responsive Design**: Mobile-first approach with adaptive layouts
- **Real-time Updates**: Live tracking and instant feedback

## Tech Stack

- **Frontend**: React, TypeScript, Next.js
- **Styling**: Tailwind CSS
- **State Management**: Redux Toolkit
- **Testing**: Jest, React Testing Library
- **CI/CD**: GitHub Actions
- **Documentation**: Markdown, TypeDoc

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Git

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/cdunn-dev/Vici.git
   cd Vici
   ```

2. Install dependencies:
   ```bash
   npm install
   # or
   yarn install
   ```

3. Set up environment variables:
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your configuration
   ```

4. Start the development server:
   ```bash
   npm run dev
   # or
   yarn dev
   ```

The application will be available at `http://localhost:3000`.

## Project Structure

```
Vici/
├── src/                    # Source code
│   ├── components/         # Reusable UI components
│   ├── pages/             # Next.js pages
│   ├── services/          # API and service integrations
│   ├── store/             # Redux store configuration
│   ├── styles/            # Global styles and Tailwind config
│   └── utils/             # Utility functions and helpers
├── public/                # Static assets
├── tests/                 # Test files
└── docs/                  # Documentation
```

## Development Workflow

1. Create a new branch for your feature:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and commit them:
   ```bash
   git add .
   git commit -m "Description of your changes"
   ```

3. Push your branch and create a pull request:
   ```bash
   git push origin feature/your-feature-name
   ```

## Testing

Run the test suite:
```bash
npm test
# or
yarn test
```

## Documentation

- [Technical Requirements](docs/TECHNICAL_REQUIREMENTS.md)
- [Testing Plan](docs/TESTING_PLAN.md)
- [Development Timeline](docs/DEVELOPMENT_TIMELINE.md)
- [Changelog](CHANGELOG.md)

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

Please ensure your PR:
- Includes tests for new features
- Updates documentation as needed
- Follows the existing code style
- Includes a clear description of changes

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For support, please open an issue in the GitHub repository or contact the maintainers.

## Acknowledgments

- Thanks to all contributors who have helped shape this project
- Special thanks to the open-source community for their tools and libraries 