
import React from 'react';
import { UploadIcon } from './icons';

interface FileUploadProps {
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: React.DragEvent<HTMLLabelElement>) => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ onChange, onDrop }) => {
  const handleDragOver = (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="w-full">
      <label
        htmlFor="file-upload"
        className="relative block w-full rounded-[1.5rem] border-2 border-dashed border-zinc-800 p-4 text-center hover:border-rose-500/50 hover:bg-rose-950/10 transition-all duration-300 cursor-pointer bg-zinc-900/40 shadow-lg backdrop-blur-sm"
        onDrop={onDrop}
        onDragOver={handleDragOver}
      >
        <div className="flex items-center justify-center gap-4">
          <div className="bg-zinc-800 p-2 rounded-xl border border-zinc-700 shadow-inner">
            <UploadIcon className="h-6 w-6 text-rose-500" />
          </div>
          <div className="text-left">
            <span className="block text-base font-black text-white">
              발주서 엑셀 파일을 올려주세요 ☁️
            </span>
            <span className="block text-[10px] text-zinc-500 font-bold uppercase tracking-wider mt-0.5">
              XLSX, XLS 통합 발주서 마우스로 끌어넣기
            </span>
          </div>
        </div>
        <input
          id="file-upload"
          name="file-upload"
          type="file"
          className="sr-only"
          accept=".xlsx, .xls, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel"
          onChange={onChange}
        />
      </label>
    </div>
  );
};

export default FileUpload;
