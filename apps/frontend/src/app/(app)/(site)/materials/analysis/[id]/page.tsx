import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';
import { MaterialsAnalysisDetail } from '@gitroom/frontend/components/materials/materials-analysis-detail.component';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Viral Analysis`,
  description: '',
};

export default async function Page() {
  return (
    <div className="bg-newBgColorInner p-[20px] flex flex-1 flex-col gap-[16px] transition-all">
      <MaterialsAnalysisDetail />
    </div>
  );
}
