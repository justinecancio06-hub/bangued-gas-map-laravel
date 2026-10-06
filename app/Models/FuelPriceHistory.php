<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Append-only audit trail. Nothing in the app updates or deletes these rows.
 */
class FuelPriceHistory extends Model
{
    use HasFactory;

    // Laravel pluralises this class to "fuel_price_histories", but the table
    // name is part of the shared schema (the SQLite and MySQL versions both
    // call it fuel_price_history), so it is stated explicitly.
    protected $table = 'fuel_price_history';

    public $timestamps = false;

    protected $fillable = [
        'station_id',
        'fuel_type',
        'previous_price',
        'new_price',
        'changed_at',
        'changed_by',
    ];

    protected function casts(): array
    {
        return [
            'previous_price' => 'float',
            'new_price' => 'float',
            'changed_at' => 'datetime',
        ];
    }

    public function station(): BelongsTo
    {
        return $this->belongsTo(Station::class);
    }

    /** Snake_case keys, matching what admin.js renderHistory() reads. */
    public function toApiArray(): array
    {
        return [
            'fuel_type' => $this->fuel_type,
            'previous_price' => $this->previous_price,
            'new_price' => (float) $this->new_price,
            'changed_at' => $this->changed_at?->format('Y-m-d H:i:s'),
            'changed_by' => $this->changed_by,
        ];
    }
}
