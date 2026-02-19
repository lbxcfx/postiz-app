
"use client";

export interface MaterialsLoginModalProps {
    qrCodeBase64?: string;
    platform: string;
}

import { useT } from "@gitroom/react/translation/get.transation.service.client";

export const MaterialsLoginModalContent = ({ qrCodeBase64, platform }: MaterialsLoginModalProps) => {
    const t = useT();
    return (
        <div className="flex flex-col items-center justify-center py-6 gap-4">
            <p className="text-sm text-gray-400">
                {t("please_open_app_scan_qr", "Please open the {{platform}} app and scan the QR code to authorize.", { platform })}
            </p>
            {qrCodeBase64 ? (
                <div className="bg-white p-2 rounded-lg">
                    <img
                        src={`data:image/png;base64,${qrCodeBase64}`}
                        alt="Login QR Code"
                        width={200}
                        height={200}
                        className="object-contain" // Tailwind class
                    />
                </div>
            ) : (
                <div className="w-[200px] h-[200px] flex items-center justify-center bg-gray-800 rounded-lg">
                    <span className="text-xs text-gray-500">{t("waiting_for_qr_code", "Waiting for QR Code...")}</span>
                </div>
            )}
            <p className="text-xs text-center text-gray-500">
                {t("cookies_stored_securely", "Cookies will be automatically stored securely after login.")}
                <br />{t("process_continue_automatically", "The process will continue automatically.")}
            </p>
        </div>
    );
};
