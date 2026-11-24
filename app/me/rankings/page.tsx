import { myRankings } from '../../../src/web/pages/boards.tsx';
import { serve } from '../../_lib/serve.tsx';

export default function Page() {
  return serve(myRankings);
}
