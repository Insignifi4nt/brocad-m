import { setCadDevelopmentChecks } from './cad/cadDevelopmentChecks';

// Every suite runs the development checks: a consumer that writes into compiled geometry fails where it writes.
setCadDevelopmentChecks(true);
