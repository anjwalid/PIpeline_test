import Swal from 'sweetalert2';

const baseButtonClasses = {
  confirmButton:
    'rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white focus:outline-none',
  cancelButton:
    'rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 focus:outline-none',
};

export async function showSuccessAlert(title: string, text?: string) {
  await Swal.fire({
    icon: 'success',
    title,
    text,
    confirmButtonText: 'OK',
    buttonsStyling: false,
    customClass: baseButtonClasses,
  });
}

export async function showErrorAlert(title: string, text?: string) {
  await Swal.fire({
    icon: 'error',
    title,
    text,
    confirmButtonText: 'Fermer',
    buttonsStyling: false,
    customClass: baseButtonClasses,
  });
}

export async function showInfoAlert(title: string, text?: string) {
  await Swal.fire({
    icon: 'info',
    title,
    text,
    confirmButtonText: 'OK',
    buttonsStyling: false,
    customClass: baseButtonClasses,
  });
}

export async function showConfirmAlert(options: {
  title: string;
  text?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  icon?: 'warning' | 'question' | 'info' | 'error';
}) {
  const result = await Swal.fire({
    icon: options.icon ?? 'warning',
    title: options.title,
    text: options.text,
    showCancelButton: true,
    confirmButtonText: options.confirmButtonText ?? 'Confirmer',
    cancelButtonText: options.cancelButtonText ?? 'Annuler',
    buttonsStyling: false,
    customClass: baseButtonClasses,
  });

  return result.isConfirmed;
}
