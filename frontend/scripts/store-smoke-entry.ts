import { crewReport, listRows, reinitializeCrew } from '../src/data/local-store'
import { loadOverview, runAction } from '../src/api/local-service'

export { crewReport, listRows, reinitializeCrew }

export function smokeService() {
  return {
    loadOverview,
    runAction,
  }
}
