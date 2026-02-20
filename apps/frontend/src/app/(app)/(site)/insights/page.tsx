import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { InsightsCenter } from '@gitroom/frontend/components/materials/insights-center.component';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Insights`,
  description: '',
};

export default async function Page() {
  return (
    <div className="bg-newBgColorInner p-[20px] flex flex-1 flex-col gap-[16px] transition-all">
      <InsightsCenter />
    </div>
  );
}
