<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class FuelPrice extends Model
{
    use HasFactory;

    public $timestamps = false;

    protected $fillable = [
        'station_id',
        'fuel_type',
        'price_per_liter',
        'effective_at',
        'updated_at',
    ];

    protected function casts(): array
    {
        return [
            'price_per_liter' => 'float',
            'effective_at' => 'datetime',
            'updated_at' => 'datetime',
        ];
    }

    public function station(): BelongsTo
    {
        return $this->belongsTo(Station::class);
    }
}
